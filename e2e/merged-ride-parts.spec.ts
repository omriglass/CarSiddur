import { expect, test } from "@playwright/test";

import { he, tv } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient } from "./helpers";
import { publishedFixtureWeek } from "./published-week";

/**
 * REQ §13.176 (owner 2026-11-01), the two production cases:
 * - Agata rides home with Galpi on the way back only; she can still drive in the morning. Volunteering for a morning
 *   ride asks nothing; on the whole of Galpi's ride it asks "already on another ride — go ahead?" and goes ahead on yes.
 * - Yarden rides on Shachar's ride and does not need it any more: "אני לא צריך/ה את הנסיעה הזו" takes him off, the ride
 *   goes on as it was.
 */
test.use({ actionTimeout: 15_000 });

const MEMBER1 = "00000000-0000-0000-0000-000000000103";
const MEMBER2 = "00000000-0000-0000-0000-000000000104";
const BINYAMINA = "00000000-0000-0000-0000-000000000012";
const RIDE_TYPE = "00000000-0000-0000-0000-000000000021";

async function fixture(week: string) {
  const service = serviceRoleClient();
  const { data: department } = await service.from("departments").select("home_destination_id").eq("id", NEVO_DEPARTMENT_ID).single();
  const { data: cars } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active").order("id").limit(2);
  const admin = await publishedFixtureWeek(week);
  await admin.auth.signOut();
  const at = (time: string) => `${week}T${time}:00+02:00`;
  const base = { department_id: NEVO_DEPARTMENT_ID, week_start: week, ride_type_id: RIDE_TYPE };
  // member1 drives their own round trip to Binyamina
  const { data: own, error } = await service.from("requests").insert(
    { ...base, requester_id: MEMBER1, filed_by: MEMBER1, origin_id: department!.home_destination_id, destination_id: BINYAMINA, trip_shape: "round_trip", depart_at: at("08:30"), return_at: at("17:45"), status: "assigned" },
  ).select("id").single();
  if (error) throw error;
  const { data: ride, error: rideError } = await service.from("rides").insert(
    { department_id: NEVO_DEPARTMENT_ID, week_start: week, car_id: cars![0]!.id, driver_id: MEMBER1, created_by: MEMBER1, needs_driver: false, flag_reason: null,
      starts_at: at("08:30"), ends_at: at("17:45"), blocked_until: at("18:15"), origin_id: department!.home_destination_id, destination_id: department!.home_destination_id, status: "confirmed" },
  ).select("id, ends_at").single();
  if (rideError) throw rideError;
  const { error: linkError } = await service.from("ride_requests").insert({ ride_id: ride!.id, request_id: own!.id, role: "driver", leg: "both", car_mode: "keep" });
  if (linkError) throw linkError;
  return { service, at, base, home: department!.home_destination_id as string, cars: cars!, ride: ride! };
}

async function cleanup(week: string) {
  const service = serviceRoleClient();
  const { data: weekRides } = await service.from("rides").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
  if (weekRides?.length) {
    const ids = weekRides.map((r) => r.id);
    await service.from("ride_requests").delete().in("ride_id", ids);
    await service.from("ride_passengers").delete().in("ride_id", ids);
  }
  await service.from("rides").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
  await service.from("notifications").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
  await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
}

test("a way-back passenger can still drive in the morning; the whole ride asks first", { tag: ["@siddur"] }, async ({ browser }) => {
  test.slow();
  const WEEK = "2041-04-14";
  const { service, at, ride, cars, home } = await fixture(WEEK);
  const member2 = await newSignedInPage(browser, SEEDED_USERS.member2);
  try {
    // member2 is named on member1's ride for the way back only; a driverless ride in the morning on the other car
    const { error: passengerError } = await service.from("ride_passengers").insert({ ride_id: ride.id, department_id: NEVO_DEPARTMENT_ID, week_start: WEEK,
      person_id: MEMBER2, display_name: SEEDED_USERS.member2.fullName, seat_kind: "adult", added_by: MEMBER1, leg: "return" });
    if (passengerError) throw passengerError;
    const { data: morning, error: morningError } = await service.from("rides").insert(
      { department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, car_id: cars[1]!.id, driver_id: null, needs_driver: true, created_by: MEMBER1, is_pinned: true, pin_reason: "MISSING_DRIVER",
        starts_at: at("09:00"), ends_at: at("10:00"), blocked_until: at("10:30"), origin_id: home, destination_id: home, status: "flagged", flag_reason: "NEEDS_DRIVER" },
    ).select("id").single();
    if (morningError) throw morningError;
    const driverOf = async () => (await service.from("rides").select("driver_id").eq("id", morning!.id).single()).data?.driver_id ?? null;

    const page = member2.page;
    await page.setViewportSize({ width: 1440, height: 1400 });
    await page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${WEEK}`);
    await page.locator(`[data-ride-id="${morning!.id}"]:visible`).click();
    await page.getByTestId("ride-peek-open").click();
    await page.getByRole("button", { name: he.rideCoordination.volunteer }).click();
    await expect.poll(driverOf).toBe(MEMBER2);
    await expect(page.getByRole("dialog").filter({ hasText: he.personBusy.title })).toHaveCount(0);

    // on the whole of member1's ride instead: asked, then done
    await service.from("rides").update({ driver_id: null, needs_driver: true, status: "flagged", flag_reason: "NEEDS_DRIVER" }).eq("id", morning!.id);
    await service.from("ride_passengers").update({ leg: "both" }).eq("ride_id", ride.id).eq("person_id", MEMBER2);
    await page.reload();
    await page.locator(`[data-ride-id="${morning!.id}"]:visible`).click();
    await page.getByTestId("ride-peek-open").click();
    await page.getByRole("button", { name: he.rideCoordination.volunteer }).click();
    const question = page.getByRole("dialog").filter({ hasText: he.personBusy.title });
    await expect(question).toContainText(SEEDED_USERS.member1.fullName);
    await question.getByRole("button", { name: he.personBusy.confirm }).click();
    await expect.poll(driverOf).toBe(MEMBER2);
  } finally {
    await member2.context.close().catch(() => undefined);
    await cleanup(WEEK);
  }
});

test("a guest leaves someone's ride with one button; the ride goes on", { tag: ["@siddur"] }, async ({ browser }) => {
  test.slow();
  const WEEK = "2041-04-21";
  const { service, at, base, home, ride } = await fixture(WEEK);
  const member2 = await newSignedInPage(browser, SEEDED_USERS.member2);
  try {
    const { data: guest, error } = await service.from("requests").insert(
      { ...base, requester_id: MEMBER2, filed_by: MEMBER2, origin_id: home, destination_id: BINYAMINA, trip_shape: "one_way_to", trip_type: "drop_off", one_way_car_mode: "passenger", depart_at: at("08:30"), status: "merged" },
    ).select("id").single();
    if (error) throw error;
    const { error: linkError } = await service.from("ride_requests").insert({ ride_id: ride.id, request_id: guest!.id, role: "passenger", leg: "out", car_mode: "passenger" });
    if (linkError) throw linkError;

    const page = member2.page;
    await page.setViewportSize({ width: 1440, height: 1400 });
    await page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${WEEK}`);
    await page.locator(`[data-ride-id="${ride.id}"]:visible`).click();
    await page.getByTestId("ride-peek-open").click();
    await page.getByTestId("remove-me").click();
    const confirm = page.getByRole("dialog").filter({ hasText: he.rideDetail.leaveRideConfirmTitle });
    await expect(confirm).toContainText(tv("rideDetail.leaveRideConfirmBody", { driver: SEEDED_USERS.member1.fullName }));
    await confirm.getByRole("button", { name: he.rideDetail.leaveRideConfirm }).click();

    await expect.poll(async () => (await service.from("requests").select("status").eq("id", guest!.id).single()).data?.status).toBe("withdrawn");
    const { data: after } = await service.from("rides").select("status, ends_at, driver_id").eq("id", ride.id).single();
    expect(after).toMatchObject({ status: "confirmed", driver_id: MEMBER1 });
    expect(Date.parse(after!.ends_at)).toBe(Date.parse(ride.ends_at));
  } finally {
    await member2.context.close().catch(() => undefined);
    await cleanup(WEEK);
  }
});
