import { expect, test, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { he } from "../src/i18n/he";
import { newSignedInPage, NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, scrollGridColumnTo } from "./helpers";

/**
 * REQ §13.175, the production case of 2026-11-01: the host drives home -> פרדס חנה and back (13:00–14:30); the guest
 * waits in בנימינה for a 15:30 pickup. Dropping the pickup on the host's ride: the popup says the guest joins on the way
 * back and that the detour is long; "כן, כבר סיכמנו" asks whether to take the guest at the ride's time or stretch the
 * ride to 15:30, then "the detour is long — merge anyway?"; the merge applies with the ride ending later.
 */
const WEEK = "2042-02-09";
const HOST_MEMBER = "00000000-0000-0000-0000-000000000103";
const GUEST_MEMBER = "00000000-0000-0000-0000-000000000104";
const HOME = "00000000-0000-0000-0000-000000000010";
const BINYAMINA = "00000000-0000-0000-0000-000000000012";
const PARDES_HANA = "00000000-0000-0000-0000-000000000017";
const at = (time: string) => `2042-02-11T${time}:00+02:00`;
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
  await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  await service.from("notifications").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
}

async function fixture(service: SupabaseClient) {
  const { data: cars } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active").limit(1);
  const base = { department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, ride_type_id: "00000000-0000-0000-0000-000000000021" };
  const { data: requests, error } = await service.from("requests").insert([
    { ...base, requester_id: HOST_MEMBER, filed_by: HOST_MEMBER, origin_id: HOME, destination_id: PARDES_HANA, trip_shape: "round_trip", trip_type: "round_trip", depart_at: at("13:00"), return_at: at("14:15"), status: "assigned" },
    // a pickup only: בנימינה -> home at 15:30
    { ...base, requester_id: GUEST_MEMBER, filed_by: GUEST_MEMBER, origin_id: HOME, destination_id: BINYAMINA, trip_shape: "one_way_from", trip_type: "drop_off", one_way_car_mode: "passenger", return_at: at("15:30"), status: "submitted" },
  ]).select("id");
  if (error) throw error;
  const { data: ride, error: rideError } = await service.from("rides").insert({
    department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, car_id: cars![0]!.id, created_by: HOST_MEMBER, driver_id: HOST_MEMBER,
    origin_id: HOME, destination_id: HOME, status: "draft", starts_at: at("13:00"), ends_at: at("14:30"), blocked_until: at("15:00"),
  }).select("id").single();
  if (rideError) throw rideError;
  const { error: linkError } = await service.from("ride_requests").insert([{ ride_id: ride.id, request_id: requests![0]!.id, role: "driver", leg: "both", car_mode: "keep" }]);
  if (linkError) throw linkError;
  return { carId: cars![0]!.id, guestRequestId: requests![1]!.id, rideId: ride.id };
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

test.describe("a long-detour merge that waits for its guest", { tag: ["@board"] }, () => {
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
  });

  test.afterEach(async () => {
    if (settings) await service.from("department_settings").update(settings).eq("department_id", NEVO_DEPARTMENT_ID);
    await cleanup(service);
  });

  test("asks about the detour and the pickup time, then stretches the ride to the guest's time", async ({ browser }) => {
    test.slow();
    const { carId, guestRequestId, rideId } = await fixture(service);
    const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
    try {
      const page = sadran.page;
      await page.setViewportSize({ width: 1600, height: 1100 });
      await page.goto(boardUrl);
      await dragRequest(page, guestRequestId, carId, 840);
      const dialog = page.getByTestId("merge-dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId("merge-long-detour")).toBeVisible();
      await expect(dialog.getByTestId("merge-result-leg-return")).toContainText("בדרך חזרה");
      await expect(dialog.getByTestId("merge-invalid")).toHaveCount(0);
      await dialog.getByTestId("merge-agreed").click();

      const wait = page.getByTestId("merge-wait-dialog");
      await expect(wait).toBeVisible();
      await expect(wait.getByTestId("merge-wait-extend")).toContainText("15:30");
      await wait.getByTestId("merge-wait-extend").click();

      const detour = page.getByRole("dialog").filter({ hasText: he.mergedRide.longDetourTitle });
      await expect(detour).toContainText("בנימינה");
      await detour.getByRole("button", { name: he.mergedRide.longDetourConfirm }).click();

      await expect.poll(async () => (await service.from("ride_requests").select("leg").eq("ride_id", rideId).eq("request_id", guestRequestId).maybeSingle()).data?.leg)
        .toBe("return");
      const { data: ride } = await service.from("rides").select("ends_at").eq("id", rideId).single();
      expect(Date.parse(ride!.ends_at)).toBeGreaterThanOrEqual(Date.parse(at("15:30")));
    } finally {
      await sadran.context.close();
    }
  });
});
