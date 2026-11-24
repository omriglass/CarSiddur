import { expect, test, type Locator, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { he } from "../src/i18n/he";
import { newSignedInPage, NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, scrollGridColumnTo } from "./helpers";

/**
 * Owner 2026-11-24 (production week 2026-11-22): the Sadran must be able to merge a member who does not drive into
 * someone else's ride, a long detour only asks (REQ §13.175 a), and a trip with its own stop is never merged silently
 * (REQ item 267). The guest's הקפצה is placed the way auto-fill leaves it - a ride with no driver on another car -
 * and dragged onto the host's ride; a second guest with a stop is dropped from the list.
 */
const WEEK = "2042-02-16";
const HOST_MEMBER = "00000000-0000-0000-0000-000000000103";
const GUEST_MEMBER = "00000000-0000-0000-0000-000000000104";
const HOME = "00000000-0000-0000-0000-000000000010";
const BINYAMINA = "00000000-0000-0000-0000-000000000012";
const ZICHRON = "00000000-0000-0000-0000-000000000013";
const PARDES_HANA = "00000000-0000-0000-0000-000000000017";
const at = (time: string) => `2042-02-18T${time}:00+02:00`;
const boardUrl = `/sadran/${NEVO_DEPARTMENT_ID}/${WEEK}/board`;

async function ensureUnpublishedWeek(service: SupabaseClient): Promise<void> {
  const { data: existing } = await service.from("weeks").select("phase").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK).maybeSingle();
  if (!existing) {
    const day = (daysBefore: number) => new Date(Date.parse(`${WEEK}T00:00:00Z`) - daysBefore * 86400000).toISOString();
    const { error } = await service.from("weeks").insert({ department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, phase: "solving", open_at: day(7), close_at: day(3), publish_at: day(2) });
    if (error) throw error;
  }
}

async function cleanup(service: SupabaseClient) {
  await service.from("proposals").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  const { data: rides } = await service.from("rides").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  if (rides?.length) await service.from("ride_requests").delete().in("ride_id", rides.map((ride) => ride.id));
  await service.from("rides").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  const { data: requests } = await service.from("requests").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  if (requests?.length) await service.from("request_stops").delete().in("request_id", requests.map((request) => request.id));
  await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  await service.from("notifications").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
}

/** The host drives home -> פרדס חנה and back on car A; the guest (does not drive) wants a הקפצה to בנימינה at 13:00. */
async function fixture(service: SupabaseClient, guestPlaced: boolean, guestStop?: string) {
  const { data: cars } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active").order("name").limit(2);
  const [carA, carB] = [cars![0]!.id, cars![1]!.id];
  const base = { department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, ride_type_id: "00000000-0000-0000-0000-000000000021" };
  const { data: requests, error } = await service.from("requests").insert([
    { ...base, requester_id: HOST_MEMBER, filed_by: HOST_MEMBER, origin_id: HOME, destination_id: PARDES_HANA, trip_shape: "round_trip", trip_type: "round_trip", depart_at: at("13:00"), return_at: at("15:15"), flex_depart_late: "00:00:00", status: "assigned", status_reason: null },
    { ...base, requester_id: GUEST_MEMBER, filed_by: GUEST_MEMBER, origin_id: HOME, destination_id: BINYAMINA, trip_shape: "one_way_to", trip_type: "drop_off", one_way_car_mode: "passenger", depart_at: at("13:00"), flex_depart_late: "01:00:00", status: guestPlaced ? "waitlisted" : "submitted", status_reason: guestPlaced ? "UNMET_NEEDS_DRIVER" : null },
  ]).select("id");
  if (error) throw error;
  const [hostRequestId, guestRequestId] = [requests![0]!.id, requests![1]!.id];
  if (guestStop) {
    const { error: stopError } = await service.from("request_stops").insert({ request_id: guestRequestId, department_id: NEVO_DEPARTMENT_ID, leg: "out", position: 1, place_id: guestStop });
    if (stopError) throw stopError;
  }
  const { data: host, error: hostError } = await service.from("rides").insert({
    department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, car_id: carA, created_by: HOST_MEMBER, driver_id: HOST_MEMBER,
    origin_id: HOME, destination_id: HOME, status: "draft", starts_at: at("13:00"), ends_at: at("15:30"), blocked_until: at("16:00"),
  }).select("id").single();
  if (hostError) throw hostError;
  const links: Record<string, unknown>[] = [{ ride_id: host.id, request_id: hostRequestId, role: "driver", leg: "both", car_mode: "keep" }];
  let guestRideId: string | null = null;
  if (guestPlaced) {
    const { data: guestRide, error: guestError } = await service.from("rides").insert({
      department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, car_id: carB, created_by: HOST_MEMBER, driver_id: null, needs_driver: true,
      origin_id: HOME, destination_id: HOME, status: "draft", starts_at: at("13:00"), ends_at: at("14:00"), blocked_until: at("14:30"),
    }).select("id").single();
    if (guestError) throw guestError;
    guestRideId = guestRide.id;
    links.push({ ride_id: guestRide.id, request_id: guestRequestId, role: "passenger", leg: "out", car_mode: "chauffeur" });
  }
  const { error: linkError } = await service.from("ride_requests").insert(links);
  if (linkError) throw linkError;
  return { carA, hostRideId: host.id as string, guestRequestId, guestRideId };
}

async function dragOnto(page: Page, from: Locator, to: Locator) {
  await from.scrollIntoViewIfNeeded();
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + Math.min(a.height, b.height) / 2, { steps: 12 });
  await page.mouse.up();
}

async function dragRequest(page: Page, requestId: string, carId: string, minutes: number) {
  const grip = page.locator(`[data-request-id="${requestId}"]:visible`).getByRole("button", { name: he.sadranBoard.dragHandleLabel });
  await grip.scrollIntoViewIfNeeded();
  const column = page.locator(`[data-car-col-id="${carId}"]`);
  await scrollGridColumnTo(column, minutes);
  const source = await grip.boundingBox();
  const target = await column.boundingBox();
  if (!source || !target) throw new Error("missing drag source/target");
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + (minutes - 360) / 1080 * target.height, { steps: 12 });
  await expect(page.locator("[data-drag-preview]")).toBeVisible();
  await page.mouse.up();
}

/** "כן, כבר סיכמנו", then whatever the board asks (pickup time, long detour, skipped stops) is answered yes. */
async function agreeAndConfirm(page: Page, expectAsked: string[]) {
  const dialog = page.getByTestId("merge-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("merge-invalid")).toHaveCount(0);
  await dialog.getByTestId("merge-agreed").click();
  const wait = page.getByTestId("merge-wait-dialog");
  for (const title of expectAsked) {
    if (await wait.isVisible().catch(() => false)) await wait.getByTestId("merge-wait-keep").click();
    const ask = page.getByRole("dialog").filter({ hasText: title });
    await expect(ask).toBeVisible();
    await ask.getByRole("button", { name: he.mergedRide.longDetourConfirm }).click();
  }
}

test.describe("the Sadran merges a member who does not drive", { tag: ["@board"] }, () => {
  let service: SupabaseClient;
  let settings: { detour_limit_minutes: number | null; detour_limit_km: number | null } | null = null;

  test.beforeEach(async () => {
    service = serviceRoleClient();
    await ensureUnpublishedWeek(service);
    await cleanup(service);
    const { data } = await service.from("department_settings").select("detour_limit_minutes,detour_limit_km").eq("department_id", NEVO_DEPARTMENT_ID).single();
    settings = data;
    // any added driving is over the limit
    await service.from("department_settings").update({ detour_limit_minutes: 1, detour_limit_km: 0.1 }).eq("department_id", NEVO_DEPARTMENT_ID);
    await service.from("profiles").update({ does_not_drive: true }).eq("id", GUEST_MEMBER);
  });

  test.afterEach(async () => {
    if (settings) await service.from("department_settings").update(settings).eq("department_id", NEVO_DEPARTMENT_ID);
    await service.from("profiles").update({ does_not_drive: false }).eq("id", GUEST_MEMBER);
    await cleanup(service);
  });

  test("a driverless הקפצה ride dragged onto a ride joins it after the long-detour question", async ({ browser }) => {
    test.slow();
    const { hostRideId, guestRequestId, guestRideId } = await fixture(service, true);
    const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
    try {
      const page = sadran.page;
      await page.setViewportSize({ width: 1600, height: 1100 });
      await page.goto(boardUrl);
      const guestRide = page.locator(`[data-ride-id="${guestRideId}"]:visible`);
      await expect(guestRide).toBeVisible();
      // a ride block drags in edit mode (REQ §13.165)
      await page.getByTestId("edit-mode-button").locator("visible=true").click();
      await dragOnto(page, guestRide, page.locator(`[data-ride-id="${hostRideId}"]:visible`));
      await agreeAndConfirm(page, [he.mergedRide.longDetourTitle]);
      await expect.poll(async () => (await service.from("ride_requests").select("leg,role").eq("ride_id", hostRideId).eq("request_id", guestRequestId).maybeSingle()).data)
        .toEqual({ leg: "out", role: "passenger" });
    } finally {
      await sadran.context.close();
    }
  });

  test("a trip with its own stop asks before the stop is left out, then merges", async ({ browser }) => {
    test.slow();
    const { carA, hostRideId, guestRequestId } = await fixture(service, false, ZICHRON);
    const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
    try {
      const page = sadran.page;
      await page.setViewportSize({ width: 1600, height: 1100 });
      await page.goto(boardUrl);
      await dragRequest(page, guestRequestId, carA, 810);
      await agreeAndConfirm(page, [he.mergedRide.longDetourTitle, he.mergedRide.skippedStopsTitle]);
      await expect(page.getByRole("dialog").filter({ hasText: he.mergedRide.skippedStopsTitle })).toHaveCount(0);
      await expect.poll(async () => (await service.from("ride_requests").select("leg").eq("ride_id", hostRideId).eq("request_id", guestRequestId).maybeSingle()).data?.leg)
        .toBe("out");
    } finally {
      await sadran.context.close();
    }
  });
});
