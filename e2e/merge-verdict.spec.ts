import { expect, test, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { he } from "../src/i18n/he";
import { newSignedInPage, NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient } from "./helpers";

/**
 * The merge popup takes the SERVER's verdict (REQ item 108 e / M1, commit bec4234): `merge_preview`
 * decides whether a leg may be merged, the popup shows the server's reason (`he.mergedRide.invalid.*`)
 * and disables the send/draft actions on a refusal. The client's instant drag highlight is advisory only,
 * so a refusal the TS twin cannot know about still opens the popup, in its refused state. The refusal used
 * here is the turnaround: the grown (earlier-departing) window runs into the buffer of the previous ride on
 * the car, which the twin does not count (it only compares actual ride spans), while `_merge_window_conflict`
 * does. (A maintenance block over the grown window is also refused by the server with code `maintenance`, but
 * the twin refuses it first with a toast, so it never reaches the popup.)
 */
const WEEK = "2042-01-26";
const HOST_MEMBER = "00000000-0000-0000-0000-000000000103";
const GUEST_MEMBER = "00000000-0000-0000-0000-000000000104";
const HOME = "00000000-0000-0000-0000-000000000010";
const HAIFA = "00000000-0000-0000-0000-000000000011";
const BINYAMINA = "00000000-0000-0000-0000-000000000012";
const at = (time: string) => `${WEEK}T${time}:00+02:00`;
const boardUrl = `/sadran/${NEVO_DEPARTMENT_ID}/${WEEK}/board`;

async function ensureUnpublishedWeek(service: SupabaseClient): Promise<void> {
  const { data: existing } = await service.from("weeks").select("phase").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK).maybeSingle();
  if (!existing) {
    const day = (daysBefore: number) => new Date(Date.parse(`${WEEK}T00:00:00Z`) - daysBefore * 86400000).toISOString();
    const { error } = await service.from("weeks").insert({ department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, phase: "solving", open_at: day(7), close_at: day(3), publish_at: day(2) });
    if (error) throw error;
  } else if (existing.phase !== "solving" && existing.phase !== "open") {
    const { error } = await service.from("weeks").update({ phase: "solving" }).eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
    if (error) throw error;
  }
}

async function cleanup(service: SupabaseClient) {
  await service.from("proposals").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  const { data: rides } = await service.from("rides").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  if (rides?.length) await service.from("ride_requests").delete().in("ride_id", rides.map((ride) => ride.id));
  await service.from("rides").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  await service.from("notifications").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
}

/** Host: a one-way home -> Haifa ride at 07:15. Guest: a one-way Binyamina -> Haifa request (a pickup on the way, so the ride must leave earlier). */
async function fixture(service: SupabaseClient) {
  const { data: cars } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active").limit(1);
  const base = { department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, ride_type_id: "00000000-0000-0000-0000-000000000021" };
  const { data: requests, error } = await service.from("requests").insert([
    { ...base, requester_id: HOST_MEMBER, filed_by: HOST_MEMBER, destination_id: HAIFA, trip_shape: "one_way_to", trip_type: "one_way", one_way_car_mode: "relay", depart_at: at("07:15"), status: "assigned" },
    { ...base, requester_id: GUEST_MEMBER, filed_by: GUEST_MEMBER, origin_id: BINYAMINA, destination_id: HAIFA, trip_shape: "one_way_to", trip_type: "one_way", one_way_car_mode: "passenger", depart_at: at("07:00"), status: "submitted" },
  ]).select("id");
  if (error) throw error;
  const { data: ride, error: rideError } = await service.from("rides").insert({
    department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, car_id: cars![0]!.id, created_by: HOST_MEMBER, driver_id: HOST_MEMBER,
    origin_id: HOME, destination_id: HAIFA, status: "confirmed", starts_at: at("07:15"), ends_at: at("08:15"), blocked_until: at("08:45"),
  }).select("id").single();
  if (rideError) throw rideError;
  const { error: linkError } = await service.from("ride_requests").insert([{ ride_id: ride.id, request_id: requests![0]!.id, role: "driver", leg: "out", car_mode: "relay" }]);
  if (linkError) throw linkError;
  return { carId: cars![0]!.id, guestRequestId: requests![1]!.id, rideId: ride.id };
}

async function dragRequest(page: Page, requestId: string, carId: string, minutes: number) {
  const grip = page.locator(`[data-request-id="${requestId}"]:visible`).getByRole("button", { name: he.sadranBoard.dragHandleLabel });
  await grip.scrollIntoViewIfNeeded();
  const column = page.locator(`[data-car-col-id="${carId}"]`);
  await column.evaluate((el, minute) => {
    const scroller = el.closest<HTMLElement>(".overflow-auto")!;
    scroller.scrollTop = Math.max(0, (minute - 360) / 1080 * el.scrollHeight - scroller.clientHeight / 2);
  }, minutes);
  const source = await grip.boundingBox();
  const target = await column.boundingBox();
  if (!source || !target) throw new Error("missing drag source/target");
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + (minutes - 360) / 1080 * target.height, { steps: 12 });
  await expect(page.locator("[data-drag-preview]")).toBeVisible();
  await page.mouse.up();
}

test.describe("merge popup takes the server's verdict", { tag: ["@board"] }, () => {
  let service: SupabaseClient;
  let settings: { detour_limit_minutes: number | null; detour_limit_km: number | null } | null = null;

  test.beforeEach(async () => {
    service = serviceRoleClient();
    await ensureUnpublishedWeek(service);
    await cleanup(service);
    const { data } = await service.from("department_settings").select("detour_limit_minutes,detour_limit_km").eq("department_id", NEVO_DEPARTMENT_ID).single();
    settings = data;
    // The Binyamina pickup adds more driving than the default 20 min / 15 km: only the server's other checks should decide here.
    await service.from("department_settings").update({ detour_limit_minutes: 90, detour_limit_km: 200 }).eq("department_id", NEVO_DEPARTMENT_ID);
  });

  test.afterEach(async () => {
    if (settings) await service.from("department_settings").update(settings).eq("department_id", NEVO_DEPARTMENT_ID);
    await cleanup(service);
  });

  test("an allowed merge enables send and draft; the previous ride's turnaround over the grown window is refused with the server's reason", async ({ browser }) => {
    test.slow();
    const { carId, guestRequestId, rideId } = await fixture(service);
    const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
    try {
      const page = sadran.page;
      await page.setViewportSize({ width: 1600, height: 1100 });
      await page.goto(boardUrl);

      await test.step("allowed: the server accepts, both actions are enabled and no reason is shown", async () => {
        await dragRequest(page, guestRequestId, carId, 450);
        const dialog = page.getByTestId("merge-dialog");
        await expect(dialog).toBeVisible();
        await expect(dialog.getByTestId("merge-departs-earlier")).toContainText("07:15");
        await expect(dialog.getByTestId("merge-invalid")).toHaveCount(0);
        await expect(dialog.getByTestId("merge-checking")).toHaveCount(0);
        await expect(dialog.getByTestId("merge-prepare")).toBeEnabled();
        await expect(dialog.getByTestId("merge-save-draft")).toBeEnabled();
        await dialog.getByRole("button", { name: he.common.cancel, exact: true }).click();
        await expect(dialog).not.toBeVisible();
      });

      await test.step("set up: a ride on the host car 06:15-06:45 whose turnaround runs to the host's 07:15 start", async () => {
        const { error } = await service.from("rides").insert({
          department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, car_id: carId, created_by: HOST_MEMBER, driver_id: HOST_MEMBER,
          origin_id: HOME, destination_id: HOME, status: "confirmed", starts_at: at("06:15"), ends_at: at("06:45"), blocked_until: at("07:15"),
        });
        if (error) throw error;
        await page.reload();
      });

      await test.step("refused: reason from the server's code, send and draft disabled, nothing written", async () => {
        await dragRequest(page, guestRequestId, carId, 450);
        const dialog = page.getByTestId("merge-dialog");
        await expect(dialog).toBeVisible();
        const invalid = dialog.getByTestId("merge-invalid");
        await expect(invalid).toHaveText(he.mergedRide.invalid.turnaround_conflict);
        await expect(invalid).toHaveAttribute("data-code", "turnaround");
        await expect(dialog.getByTestId("merge-prepare")).toBeDisabled();
        await expect(dialog.getByTestId("merge-save-draft")).toBeDisabled();
        await dialog.getByRole("button", { name: he.common.cancel, exact: true }).click();
        await expect(dialog).not.toBeVisible();
        const { data: proposals } = await service.from("proposals").select("id").eq("request_id", guestRequestId);
        expect(proposals).toHaveLength(0);
        await expect(page.locator(`button[data-ride-id="${rideId}"]:visible`)).toHaveCount(1);
        await expect(page.locator('button[data-merged="true"]:visible')).toHaveCount(0);
      });
    } finally {
      await sadran.context.close().catch(() => undefined);
    }
  });
});
