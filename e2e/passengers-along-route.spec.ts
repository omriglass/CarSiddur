import { expect, test, type Page } from "@playwright/test";

import { he, tv } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient } from "./helpers";
import { publishedFixtureWeek } from "./published-week";

/**
 * REQ item 246 h (LT1 phase 2b–2e), the owner's mock boards 4–5: member1 drives home -> זכרון יעקב (school, arrive by
 * 08:15) -> בנימינה and back the same way. גל gets off at school and back on there; טל rides the whole way.
 * - the stops view: ↓/↑ at school, free seats per stretch, the stated hour with a lock; the people summary in words;
 * - the Sadran taps טל's name and makes it "רק הלוך";
 * - admin joins with "+ נוסע/ת", getting on at school;
 * - member2 (a one-way guest on the way back) leaves with "לצאת מהנסיעה".
 */
test.use({ actionTimeout: 15_000 });

const MEMBER1 = "00000000-0000-0000-0000-000000000103";
const MEMBER2 = "00000000-0000-0000-0000-000000000104";
const ADMIN = "00000000-0000-0000-0000-000000000101";
const BINYAMINA = "00000000-0000-0000-0000-000000000012";
const ZICHRON = "00000000-0000-0000-0000-000000000013";
const RIDE_TYPE = "00000000-0000-0000-0000-000000000021";
const VAN = "00000000-0000-0000-0000-000000000041";

async function fixture(week: string) {
  await cleanup(week);   // an earlier run that stopped half way
  const service = serviceRoleClient();
  const { data: department } = await service.from("departments").select("home_destination_id").eq("id", NEVO_DEPARTMENT_ID).single();
  const home = department!.home_destination_id as string;
  const admin = await publishedFixtureWeek(week);
  await admin.auth.signOut();
  const at = (time: string) => `${week}T${time}:00+03:00`;   // May: summer time
  const base = { department_id: NEVO_DEPARTMENT_ID, week_start: week, ride_type_id: RIDE_TYPE };
  const { data: own, error } = await service.from("requests").insert(
    { ...base, requester_id: MEMBER1, filed_by: MEMBER1, origin_id: home, destination_id: BINYAMINA, trip_shape: "round_trip",
      depart_at: at("07:45"), return_at: at("17:00"), status: "assigned", adults: 3, guest_passenger_names: ["גל", "טל"],
      depart_anchor: "arrive", arrive_by: at("09:30") },
  ).select("id").single();
  if (error) throw error;
  const { error: stopsError } = await service.from("request_stops").insert([
    { request_id: own!.id, department_id: NEVO_DEPARTMENT_ID, leg: "out", position: 1, place_id: ZICHRON, fixed_anchor: "arrive", fixed_at: at("08:15"), flex_minutes: 0 },
    { request_id: own!.id, department_id: NEVO_DEPARTMENT_ID, leg: "return", position: 1, place_id: ZICHRON, fixed_anchor: null, fixed_at: null, flex_minutes: 0 },
  ]);
  if (stopsError) throw stopsError;
  const { error: ridersError } = await service.from("request_rider_stops").insert([
    { request_id: own!.id, department_id: NEVO_DEPARTMENT_ID, rider_key: "guest:1", leg: "out", rides: true, alight_place_id: ZICHRON },
    { request_id: own!.id, department_id: NEVO_DEPARTMENT_ID, rider_key: "guest:1", leg: "return", rides: true, board_place_id: ZICHRON },
  ]);
  if (ridersError) throw ridersError;
  const { data: ride, error: rideError } = await service.from("rides").insert(
    { department_id: NEVO_DEPARTMENT_ID, week_start: week, car_id: VAN, driver_id: MEMBER1, created_by: MEMBER1, needs_driver: false, flag_reason: null,
      starts_at: at("07:45"), ends_at: at("17:00"), blocked_until: at("17:30"), origin_id: home, destination_id: home, status: "confirmed" },
  ).select("id").single();
  if (rideError) throw rideError;
  const { error: linkError } = await service.from("ride_requests").insert({ ride_id: ride!.id, request_id: own!.id, role: "driver", leg: "both", car_mode: "keep" });
  if (linkError) throw linkError;
  return { service, at, base, home, ride: ride!, request: own! };
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
  const { data: requests } = await service.from("requests").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
  if (requests?.length) {
    const ids = requests.map((r) => r.id);
    await service.from("request_rider_stops").delete().in("request_id", ids);
    await service.from("request_stops").delete().in("request_id", ids);
  }
  await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
}

async function openRide(page: Page, week: string, rideId: string) {
  await page.setViewportSize({ width: 430, height: 1600 });
  await page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${week}?ride=${rideId}`);
  await expect(page.getByTestId("ride-stops-view")).toBeVisible();
}

test("the stops view and the people summary; the Sadran makes a passenger 'only there'", { tag: ["@ride-passengers"] }, async ({ browser }) => {
  test.slow();
  const WEEK = "2041-05-05";
  const { service, ride, request } = await fixture(WEEK);
  const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
  try {
    const page = sadran.page;
    await openRide(page, WEEK, ride.id);
    const school = page.getByTestId("ride-stop-out-1");
    await expect(school).toContainText(tv("rideStops.off", { names: "גל" }));
    await expect(school.getByTestId("ride-stop-fixed")).toContainText("08:15");
    await expect(page.getByTestId("ride-stop-out-0").getByTestId("ride-stop-free")).toBeVisible();
    await expect(page.getByTestId("ride-stop-return-1")).toContainText(tv("rideStops.on", { names: "גל" }));
    await expect(page.locator('[data-person-key$=":1"]').getByTestId("ride-person-where")).toContainText("↓ זכרון יעקב (");

    // טל: tap the name -> "רק הלוך" -> save
    await page.getByRole("button", { name: tv("addPassengers.editAriaLabel", { name: "טל" }) }).click();
    const dialog = page.getByTestId("ride-person-dialog");
    await dialog.getByTestId("ride-part-out").click();
    await expect(page.getByTestId("ride-part-room")).toHaveText(he.addPassengers.room);
    await page.getByRole("button", { name: he.addPassengers.save }).click();
    await expect.poll(async () => (await service.from("request_rider_stops").select("rides").eq("request_id", request.id)
      .eq("rider_key", "guest:2").eq("leg", "return").maybeSingle()).data?.rides).toBe(false);
    await expect(page.locator('[data-person-key$=":2"]').getByTestId("ride-person-where")).toHaveText(he.addPassengers.part.out);
  } finally {
    await sadran.context.close().catch(() => undefined);
    await cleanup(WEEK);
  }
});

test("'+ נוסע/ת' getting on in the middle; a one-way guest leaves with one tap", { tag: ["@ride-passengers"] }, async ({ browser }) => {
  test.slow();
  const WEEK = "2041-05-12";
  const { service, ride, base, at, home } = await fixture(WEEK);
  const { data: guest, error } = await service.from("requests").insert(
    { ...base, requester_id: MEMBER2, filed_by: MEMBER2, origin_id: BINYAMINA, destination_id: home, trip_shape: "one_way_to", trip_type: "one_way",
      one_way_car_mode: "passenger", depart_at: at("16:00"), status: "merged" },
  ).select("id").single();
  if (error) throw error;
  await service.from("ride_requests").insert({ ride_id: ride.id, request_id: guest!.id, role: "passenger", leg: "return", car_mode: "passenger" });
  const admin = await newSignedInPage(browser, SEEDED_USERS.admin);
  const member2 = await newSignedInPage(browser, SEEDED_USERS.member2);
  try {
    // admin: "+ נוסע/ת" -> אני -> getting on at school on the way there only
    let page = admin.page;
    await openRide(page, WEEK, ride.id);
    await page.getByRole("button", { name: he.addPassengers.button }).click();
    await page.locator("#add-passengers-self").click();
    await page.getByTestId("ride-part-middle").click();
    await page.getByTestId("ride-part-skip-return").click();
    await page.getByTestId("ride-part-board-out-1").click();
    await page.getByRole("button", { name: he.addPassengers.submit }).click();
    await expect.poll(async () => (await service.from("ride_passengers").select("board_place_id, leg").eq("ride_id", ride.id).eq("person_id", ADMIN)
      .maybeSingle()).data).toEqual({ board_place_id: ZICHRON, leg: "out" });
    await expect(page.getByTestId("ride-stop-out-1")).toContainText(tv("rideStops.on", { names: SEEDED_USERS.admin.fullName }));

    // member2 leaves their own place on the way back
    page = member2.page;
    await openRide(page, WEEK, ride.id);
    await page.getByTestId("ride-guest-leave").click();
    const confirm = page.getByRole("dialog").filter({ hasText: tv("addPassengers.leaveTitle", { driver: SEEDED_USERS.member1.fullName }) });
    await confirm.getByRole("button", { name: he.addPassengers.leaveConfirm }).click();
    await expect.poll(async () => (await service.from("ride_requests").select("request_id").eq("ride_id", ride.id).eq("request_id", guest!.id)).data?.length).toBe(0);
    await expect.poll(async () => (await service.from("requests").select("status").eq("id", guest!.id).single()).data?.status)
      .not.toBe("merged");
    await expect.poll(async () => (await service.from("notifications").select("id").eq("recipient_id", MEMBER1)
      .eq("week_start", WEEK).in("data->>variant", ["passenger_left", "passenger_left_many"])).data?.length).toBe(1);
  } finally {
    await admin.context.close().catch(() => undefined);
    await member2.context.close().catch(() => undefined);
    await cleanup(WEEK);
  }
});
