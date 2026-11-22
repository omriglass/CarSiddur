import { expect, test, type Page } from "@playwright/test";

import { he, tv } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient } from "./helpers";
import { publishedFixtureWeek } from "./published-week";

/**
 * PS1 (REQ item 261, owner 2026-11-22; production 19.11): "+ נוסע/ת" adds the person, nothing more. member2 has an open
 * request to Binyamina at the hours of member1's Binyamina ride; adding member2 asks "ל<member2> יש נסיעה ברשימת המתנה
 * באותו זמן לאותו מקום. להשאיר אותה ברשימת המתנה, בנוסף לנסיעה הזאת?".
 * - "להשאיר ברשימת המתנה": member2 rides as a plain passenger, the request stays waiting, and closing it keeps the seat;
 * - "הוצא/י אותה מרשימת המתנה" (the main answer): the request joins the ride (a merge), no second, plain seat.
 * Own winter weeks (no other spec uses them).
 */
test.use({ actionTimeout: 15_000 });

const MEMBER1 = "00000000-0000-0000-0000-000000000103";
const MEMBER2 = "00000000-0000-0000-0000-000000000104";
const BINYAMINA = "00000000-0000-0000-0000-000000000012";
const RIDE_TYPE = "00000000-0000-0000-0000-000000000021";
const VAN = "00000000-0000-0000-0000-000000000041";

async function fixture(week: string) {
  await cleanup(week);
  const service = serviceRoleClient();
  const { data: department } = await service.from("departments").select("home_destination_id").eq("id", NEVO_DEPARTMENT_ID).single();
  const home = department!.home_destination_id as string;
  const admin = await publishedFixtureWeek(week);
  const day = new Date(Date.parse(`${week}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);   // Monday
  const at = (time: string) => `${day}T${time}:00+02:00`;   // winter time
  const base = { department_id: NEVO_DEPARTMENT_ID, week_start: week, ride_type_id: RIDE_TYPE, origin_id: home, destination_id: BINYAMINA, trip_shape: "round_trip" };
  const { data: own, error } = await service.from("requests").insert(
    { ...base, requester_id: MEMBER1, filed_by: MEMBER1, depart_at: at("08:15"), return_at: at("14:45"), status: "assigned" },
  ).select("id").single();
  if (error) throw error;
  const { data: waiting, error: waitingError } = await service.from("requests").insert(
    { ...base, requester_id: MEMBER2, filed_by: MEMBER2, depart_at: at("08:30"), return_at: at("14:00"), status: "waitlisted" },
  ).select("id, version").single();
  if (waitingError) throw waitingError;
  const { data: ride, error: rideError } = await service.from("rides").insert(
    { department_id: NEVO_DEPARTMENT_ID, week_start: week, car_id: VAN, driver_id: MEMBER1, created_by: MEMBER1, needs_driver: false, flag_reason: null,
      starts_at: at("08:15"), ends_at: at("14:45"), blocked_until: at("15:15"), origin_id: home, destination_id: home, status: "confirmed" },
  ).select("id").single();
  if (rideError) throw rideError;
  const { error: linkError } = await service.from("ride_requests").insert({ ride_id: ride!.id, request_id: own!.id, role: "driver", leg: "both", car_mode: "keep" });
  if (linkError) throw linkError;
  return { service, admin, ride: ride!, waiting: waiting! };
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
  await service.from("proposals").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
  await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
}

/** Sadran: the ride sheet on the siddur -> "+ נוסע/ת" -> member2 -> "הוספה" -> the question. */
async function addMember2(page: Page, week: string, rideId: string) {
  await page.setViewportSize({ width: 430, height: 1600 });
  await page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${week}?ride=${rideId}`);
  await expect(page.getByTestId("ride-summary")).toBeVisible();
  await page.getByRole("button", { name: he.addPassengers.button }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: he.addPassengers.title }).last();
  await dialog.getByRole("combobox").first().click();
  await page.getByRole("option", { name: SEEDED_USERS.member2.fullName }).click();
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: he.addPassengers.submit }).click();
  const question = page.getByRole("dialog").filter({ hasText: tv("addPassengers.matchQuestion", { name: SEEDED_USERS.member2.fullName }) });
  await expect(question).toBeVisible();
  return question;
}

test("'+ נוסע/ת' asks about the member's own request: no = a plain seat that closing the request keeps", { tag: ["@ride-passengers"] }, async ({ browser }) => {
  test.slow();
  const WEEK = "2047-01-06";
  const { service, admin, ride, waiting } = await fixture(WEEK);
  const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
  try {
    const question = await addMember2(sadran.page, WEEK, ride.id);
    await question.getByRole("button", { name: he.addPassengers.matchKeep }).click();
    await expect.poll(async () => (await service.from("ride_passengers").select("id").eq("ride_id", ride.id).eq("person_id", MEMBER2)).data?.length).toBe(1);
    expect((await service.from("ride_requests").select("request_id").eq("ride_id", ride.id).eq("request_id", waiting.id)).data).toHaveLength(0);
    expect((await service.from("requests").select("status").eq("id", waiting.id).single()).data?.status).toBe("waitlisted");

    // closing the request (production 19.11) never takes member2 off the ride
    const { error } = await admin.rpc("close_request", { p_request_id: waiting.id, p_expected_version: waiting.version, p_reason: "קיבלה רכב אחר" });
    expect(error).toBeNull();
    expect((await service.from("ride_passengers").select("id").eq("ride_id", ride.id).eq("person_id", MEMBER2)).data).toHaveLength(1);
  } finally {
    await sadran.context.close().catch(() => undefined);
    await admin.auth.signOut().catch(() => undefined);
    await cleanup(WEEK);
  }
});

test("'+ נוסע/ת' with yes: the member's own request joins the ride, no second seat", { tag: ["@ride-passengers"] }, async ({ browser }) => {
  test.slow();
  const WEEK = "2047-01-13";
  const { service, admin, ride, waiting } = await fixture(WEEK);
  const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
  try {
    const question = await addMember2(sadran.page, WEEK, ride.id);
    await question.getByRole("button", { name: he.addPassengers.matchMerge }).click();
    await expect.poll(async () => (await service.from("ride_requests").select("request_id").eq("ride_id", ride.id).eq("request_id", waiting.id)).data?.length).toBe(1);
    expect((await service.from("ride_passengers").select("id").eq("ride_id", ride.id).eq("person_id", MEMBER2)).data).toHaveLength(0);
    expect(["merged", "assigned"]).toContain((await service.from("requests").select("status").eq("id", waiting.id).single()).data?.status);
  } finally {
    await sadran.context.close().catch(() => undefined);
    await admin.auth.signOut().catch(() => undefined);
    await cleanup(WEEK);
  }
});
