import { expect, test, type Locator, type Page } from "@playwright/test";

import { he } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient } from "./helpers";
import { publishedFixtureWeek } from "./published-week";

/**
 * REQ §13.175 (d), the production case of 2026-11-01 on the siddur: member1 (שי) drives home -> פרדס חנה 13:00–14:30;
 * member2 (אלי) waits in בנימינה for a 15:30 pickup on a driverless ride. In edit mode שי drags his ride onto hers:
 * "take her along?" -> stretch my ride to her pickup time -> "the detour is long — merge anyway?" -> her large luggage
 * and his car without a large trunk: "אני מודע/ת" (REQ §13.175 g) -> she rides with him, her driverless ride is gone,
 * his ride ends after 15:30, the waiver is recorded.
 */
test.use({ actionTimeout: 15_000 });

const WEEK = "2041-02-10";
const MEMBER1 = "00000000-0000-0000-0000-000000000103";
const MEMBER2 = "00000000-0000-0000-0000-000000000104";
const BINYAMINA = "00000000-0000-0000-0000-000000000012";
const PARDES_HANA = "00000000-0000-0000-0000-000000000017";
const at = (time: string) => `${WEEK}T${time}:00+02:00`;

async function dragOnto(page: Page, from: Locator, to: Locator) {
  await from.scrollIntoViewIfNeeded();
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  // grab the middle (the edges resize), drop with the block's top on the other ride's top
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + a.height / 2, { steps: 12 });
  await page.mouse.up();
}

test("a member drags their ride onto someone's pickup and takes them along", { tag: ["@siddur"] }, async ({ browser }) => {
  test.slow();
  const service = serviceRoleClient();
  const { data: department } = await service.from("departments").select("home_destination_id").eq("id", NEVO_DEPARTMENT_ID).single();
  const home = department!.home_destination_id as string;
  const { data: cars } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active").order("id").limit(2);
  const { data: settings } = await service.from("department_settings").select("detour_limit_minutes,detour_limit_km").eq("department_id", NEVO_DEPARTMENT_ID).single();
  const admin = await publishedFixtureWeek(WEEK);
  await admin.auth.signOut();
  await service.from("department_settings").update({ detour_limit_minutes: 1, detour_limit_km: 0.1 }).eq("department_id", NEVO_DEPARTMENT_ID);
  const base = { department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, ride_type_id: "00000000-0000-0000-0000-000000000021" };
  // one insert per row: a batch fills a row's missing columns with null instead of their defaults
  const { data: own, error } = await service.from("requests").insert(
    { ...base, requester_id: MEMBER1, filed_by: MEMBER1, origin_id: home, destination_id: PARDES_HANA, trip_shape: "round_trip", depart_at: at("13:00"), return_at: at("14:15"), status: "assigned" },
  ).select("id").single();
  if (error) throw error;
  const { data: pickup, error: pickupError } = await service.from("requests").insert(
    { ...base, requester_id: MEMBER2, filed_by: MEMBER2, origin_id: home, destination_id: BINYAMINA, trip_shape: "one_way_from", trip_type: "drop_off", one_way_car_mode: "passenger", return_at: at("15:30"), has_luggage: true, status: "waitlisted" },
  ).select("id").single();
  if (pickupError) throw pickupError;
  const { data: hostRide, error: rideError } = await service.from("rides").insert(
    { department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, car_id: cars![0]!.id, driver_id: MEMBER1, created_by: MEMBER1, needs_driver: false, flag_reason: null,
      starts_at: at("13:00"), ends_at: at("14:30"), blocked_until: at("15:00"), origin_id: home, destination_id: home, status: "confirmed" },
  ).select("id").single();
  if (rideError) throw rideError;
  const { data: pickupRide, error: pickupRideError } = await service.from("rides").insert(
    { department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, car_id: cars![1]!.id, driver_id: null, needs_driver: true, created_by: MEMBER1,
      starts_at: at("15:00"), ends_at: at("16:00"), blocked_until: at("16:30"), origin_id: home, destination_id: home, status: "flagged", flag_reason: "NEEDS_DRIVER" },
  ).select("id").single();
  if (pickupRideError) throw pickupRideError;
  const { error: linkError } = await service.from("ride_requests").insert([
    { ride_id: hostRide!.id, request_id: own!.id, role: "driver", leg: "both", car_mode: "keep" },
    { ride_id: pickupRide!.id, request_id: pickup!.id, role: "passenger", leg: "return", car_mode: "chauffeur" },
  ]);
  if (linkError) throw linkError;

  const member1 = await newSignedInPage(browser, SEEDED_USERS.member1);
  try {
    const page = member1.page;
    await page.setViewportSize({ width: 1440, height: 1400 });
    await page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${WEEK}`);
    const mine = page.locator(`[data-ride-id="${hostRide!.id}"]:visible`);
    const hers = page.locator(`[data-ride-id="${pickupRide!.id}"]:visible`);
    await expect(mine).toBeVisible();
    await expect(hers).toBeVisible();
    await page.getByTestId("edit-mode-button").locator("visible=true").click();
    await dragOnto(page, mine, hers);

    const take = page.getByRole("dialog").filter({ hasText: SEEDED_USERS.member2.fullName });
    await expect(take).toContainText("בדרך חזרה");
    await take.getByRole("button", { name: he.rideEditing.mergeConfirm }).click();
    await page.getByTestId("merge-wait-extend").click();
    const detour = page.getByRole("dialog").filter({ hasText: he.mergedRide.longDetourTitle });
    await detour.getByRole("button", { name: he.mergedRide.longDetourConfirm }).click();
    const luggage = page.getByRole("dialog").filter({ hasText: he.smallTrunk.confirmTitle });
    await luggage.getByRole("button", { name: he.rideEditing.mergeLuggageAware }).click();

    await expect.poll(async () => (await service.from("ride_requests").select("leg").eq("ride_id", hostRide!.id).eq("request_id", pickup!.id).maybeSingle()).data?.leg)
      .toBe("return");
    const { data: after } = await service.from("rides").select("id,status,ends_at").in("id", [hostRide!.id, pickupRide!.id]);
    expect(after!.find((r) => r.id === pickupRide!.id)!.status).toBe("cancelled");
    expect(Date.parse(after!.find((r) => r.id === hostRide!.id)!.ends_at)).toBeGreaterThanOrEqual(Date.parse(at("15:30")));
    const { data: waived } = await service.from("requests").select("luggage_waived_by").eq("id", pickup!.id).single();
    expect(waived!.luggage_waived_by).toBe(MEMBER1);
  } finally {
    await member1.context.close().catch(() => undefined);
    if (settings) await service.from("department_settings").update(settings).eq("department_id", NEVO_DEPARTMENT_ID);
    // cancelling her driverless ride on another car offered the freed slot
    const { data: offers } = await service.from("freed_slot_offers").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
    if (offers?.length) await service.from("freed_slot_claims").delete().in("offer_id", offers.map((o) => o.id));
    await service.from("freed_slot_offers").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
    const { data: weekRides } = await service.from("rides").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
    if (weekRides?.length) await service.from("ride_requests").delete().in("ride_id", weekRides.map((r) => r.id));
    await service.from("rides").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
    await service.from("notifications").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
    await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  }
});
