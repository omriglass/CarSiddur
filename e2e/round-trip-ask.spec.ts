import { expect, test, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { he } from "../src/i18n/he";
import { newSignedInPage, NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, scrollGridColumnTo } from "./helpers";

// RT1 (REQ item 251, owner 2026-11-17/19; production 2026-11-18): a member's round trip rides a host's ride on the way
// out only. The Sadran stretches the ride's end to the member's return hour on the board: the ride now looks like a
// round trip, so the board asks "נראה שזו נסיעה הלוך-חזור". "כן, גם החזור" puts the member on the ride for both ways;
// "לא, רק הלוך ארוך" changes nothing and is not asked again for that ride.
// The fixture week is never published (as one-way-pair-drop.spec.ts): every step is the Sadran's.
const WEEK = "2042-03-02";
const HOME = "00000000-0000-0000-0000-000000000010";
const HAIFA = "00000000-0000-0000-0000-000000000011";
const RIDE_TYPE = "00000000-0000-0000-0000-000000000021";
const M1 = "00000000-0000-0000-0000-000000000103";
const M2 = "00000000-0000-0000-0000-000000000104";
const at = (time: string) => `${WEEK}T${time}:00+02:00`;
const boardUrl = `/sadran/${NEVO_DEPARTMENT_ID}/${WEEK}/board`;

async function ensureUnpublishedWeek(service: SupabaseClient): Promise<void> {
  const { data: existing } = await service.from("weeks").select("phase").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK).maybeSingle();
  if (!existing) {
    const before = (days: number) => new Date(Date.parse(`${WEEK}T00:00:00Z`) - days * 86_400_000).toISOString();
    const { error } = await service.from("weeks").insert({ department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, phase: "solving", open_at: before(7), close_at: before(3), publish_at: before(2) });
    if (error) throw error;
  } else if (existing.phase !== "solving" && existing.phase !== "open") {
    const { error } = await service.from("weeks").update({ phase: "solving" }).eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
    if (error) throw error;
  }
}

async function cleanup(service: SupabaseClient): Promise<void> {
  await service.from("proposals").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  const { data: rides } = await service.from("rides").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  if (rides?.length) await service.from("ride_requests").delete().in("ride_id", rides.map((ride) => ride.id));
  await service.from("rides").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  await service.from("notifications").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
}

function roundTrip(requester: string, departAt: string, returnAt: string) {
  return {
    department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, requester_id: requester, filed_by: requester, ride_type_id: RIDE_TYPE,
    origin_id: HOME, destination_id: HAIFA, trip_shape: "round_trip", trip_type: "round_trip", needs_car_at_destination: true, one_way_car_mode: null,
    depart_at: departAt, return_at: returnAt, status: "assigned", flex_return_late: "02:00:00",
  };
}

/** Drags the ride's bottom edge down until the drag preview shows `endLabel`. */
async function stretchEnd(page: Page, rideId: string, endLabel: string) {
  const block = page.locator(`[data-ride-id="${rideId}"]:visible`);
  await block.scrollIntoViewIfNeeded();
  const box = await block.locator(".bottom-0").boundingBox();
  if (!box) throw new Error("ride resize edge missing");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const preview = page.locator("[data-drag-preview]");
  for (let dy = 4; dy < 400; dy += 4) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + dy);
    if ((await preview.count()) > 0 && (await preview.first().innerText()).includes(`–${endLabel}`)) break;
  }
  await expect(preview).toContainText(`–${endLabel}`);
  await page.mouse.up();
}

/** REQ §13.165: rides drag at once only in edit mode (else a long press). */
async function openBoardInEditMode(page: Page, carId: string) {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto(boardUrl);
  const pencil = page.getByTestId("edit-mode-button").locator("visible=true");
  await expect(pencil).toBeVisible();
  if ((await pencil.getAttribute("data-on")) !== "true") await pencil.click();
  await expect(pencil).toHaveAttribute("data-on", "true");
  await scrollGridColumnTo(page.locator(`[data-car-col-id="${carId}"]`), 720);
}

async function guestLeg(service: SupabaseClient, rideId: string, requestId: string): Promise<string | null> {
  const { data } = await service.from("ride_requests").select("leg").eq("ride_id", rideId).eq("request_id", requestId).maybeSingle();
  return (data?.leg as string | undefined) ?? null;
}

test.describe("a ride that looks like a round trip asks about the way back (REQ item 251)", { tag: ["@board"] }, () => {
  test.slow();
  let service: SupabaseClient;
  let carId: string;
  let rideId: string;
  let guestId: string;

  test.beforeEach(async () => {
    service = serviceRoleClient();
    await ensureUnpublishedWeek(service);
    await cleanup(service);
    const { data: cars } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active").order("id").limit(1);
    carId = cars![0]!.id as string;
    const { data: requests, error } = await service.from("requests").insert([
      roundTrip(M1, at("09:00"), at("12:00")),
      roundTrip(M2, at("09:00"), at("13:00")),
    ]).select("id");
    if (error) throw error;
    const [hostId, guest] = requests!.map((row) => row.id as string);
    guestId = guest!;
    const { data: ride, error: rideError } = await service.from("rides").insert({ department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, car_id: carId, created_by: M1, driver_id: M1,
      origin_id: HOME, destination_id: HOME, status: "draft", is_pinned: true, pin_reason: "SADRAN_MANUAL", starts_at: at("09:00"), ends_at: at("12:00"), blocked_until: at("12:30") }).select("id").single();
    if (rideError) throw rideError;
    rideId = ride!.id as string;
    const { error: linkError } = await service.from("ride_requests").insert([
      { ride_id: rideId, request_id: hostId, role: "driver", leg: "both", car_mode: "keep" },
      // the guest rides only the way out: its way back is placed nowhere
      { ride_id: rideId, request_id: guestId, role: "passenger", leg: "out", car_mode: "passenger" },
    ]);
    if (linkError) throw linkError;
  });
  test.afterEach(async () => { await cleanup(service); });

  test("\"כן, גם החזור\" puts the guest on the ride for both ways", async ({ browser }) => {
    const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
    try {
      await openBoardInEditMode(sadran.page, carId);
      await stretchEnd(sadran.page, rideId, "13:00");
      const dialog = sadran.page.getByRole("dialog").filter({ has: sadran.page.getByRole("heading", { name: he.sadranBoard.roundTripAskTitle }) });
      await expect(dialog).toBeVisible({ timeout: 15_000 });
      await expect(dialog).toContainText("13:00");
      await dialog.getByRole("button", { name: he.sadranBoard.roundTripAskConfirm, exact: true }).click();
      await expect.poll(() => guestLeg(service, rideId, guestId), { timeout: 15_000 }).toBe("both");
    } finally {
      await sadran.context.close();
    }
  });

  test("\"לא, רק הלוך ארוך\" changes nothing and is not asked again for that ride", async ({ browser }) => {
    const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
    try {
      await openBoardInEditMode(sadran.page, carId);
      await stretchEnd(sadran.page, rideId, "13:00");
      const heading = sadran.page.getByRole("heading", { name: he.sadranBoard.roundTripAskTitle });
      await expect(heading).toBeVisible({ timeout: 15_000 });
      await sadran.page.getByRole("button", { name: he.sadranBoard.roundTripAskDecline, exact: true }).click();
      await expect(heading).toHaveCount(0);
      expect(await guestLeg(service, rideId, guestId)).toBe("out");
      await expect.poll(async () => (await service.from("rides").select("ends_at").eq("id", rideId).single()).data?.ends_at, { timeout: 15_000 })
        .toBe(new Date(at("13:00")).toISOString().replace(".000Z", "+00:00"));
      await stretchEnd(sadran.page, rideId, "13:15");
      await expect.poll(async () => (await service.from("rides").select("ends_at").eq("id", rideId).single()).data?.ends_at, { timeout: 15_000 })
        .toBe(new Date(at("13:15")).toISOString().replace(".000Z", "+00:00"));
      await sadran.page.waitForTimeout(1_500);
      await expect(heading).toHaveCount(0);
      expect(await guestLeg(service, rideId, guestId)).toBe("out");
    } finally {
      await sadran.context.close();
    }
  });
});
