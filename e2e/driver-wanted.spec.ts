import { expect, test } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient } from "./helpers";
import { publishedFixtureWeek } from "./published-week";
import { dayOfWeek, FIXTURE_WEEKS, insertRequest, PLACES, PROFILE_IDS, removeWeek, sharedCarIdByName, winterAt } from "./request-form";

// REQ §13.170: a הקפצה with no driver — the ride sheet asks on WhatsApp who can drive, naming the rider, the day,
// the place and the hour, with a link to /ride/<id>; there "אני אקח" makes the volunteer its driver.
test.use({ viewport: { width: 390, height: 844 } });

test("a driverless הקפצה asks on WhatsApp and the link's page takes the wheel", { tag: ["@siddur"] }, async ({ browser }) => {
  const service = serviceRoleClient();
  const week = FIXTURE_WEEKS.driverWanted;
  const day = dayOfWeek(week, 3);
  await removeWeek(service, week);
  const admin = await publishedFixtureWeek(week);
  await admin.auth.signOut();
  try {
    const car = await sharedCarIdByName(service, "יונדאי 1");
    const request = await insertRequest(service, day, { week, requester: PROFILE_IDS.member2, depart: "08:00", return: "09:00",
      destinationId: PLACES.binyamina.id, status: "assigned", extra: { trip_type: "drop_off", trip_shape: "one_way_to", one_way_car_mode: "passenger", return_at: null } });
    const { data: ride, error } = await service.from("rides").insert({
      department_id: NEVO_DEPARTMENT_ID, week_start: week, car_id: car, driver_id: null, created_by: PROFILE_IDS.sadran,
      starts_at: winterAt(day, "08:00"), ends_at: winterAt(day, "09:00"), blocked_until: winterAt(day, "09:30"),
      origin_id: PLACES.home.id, destination_id: PLACES.home.id, status: "flagged", flag_reason: "NEEDS_DRIVER", needs_driver: true,
    }).select("id").single();
    if (error) throw error;
    {
      const { error: linkError } = await service.from("ride_requests").insert({ ride_id: ride.id, request_id: request, role: "passenger", leg: "out", car_mode: "chauffeur" });
      if (linkError) throw linkError;
    }

    const member1 = await newSignedInPage(browser, SEEDED_USERS.member1);
    const page = member1.page;
    await page.goto(paths.siddur({ dept: NEVO_DEPARTMENT_ID, week, rideId: ride.id }));
    const ask = page.getByTestId("driver-wanted-whatsapp");
    await expect(ask).toBeVisible();
    const [popup] = await Promise.all([page.waitForEvent("popup"), ask.click()]);
    await expect.poll(() => popup.url()).not.toBe("about:blank");
    const text = new URL(popup.url()).searchParams.get("text") ?? "";
    expect(text).toContain(`יקפיץ את ${SEEDED_USERS.member2.fullName}`);
    expect(text).toContain("לבנימינה, לצאת בשעה 08:00");
    expect(text).toContain(paths.ride(ride.id));
    await popup.close();

    await page.goto(paths.ride(ride.id));
    await expect(page.getByTestId("ride-offer")).toContainText(SEEDED_USERS.member2.fullName);
    await page.getByTestId("ride-offer-take").click();
    await expect.poll(async () => (await service.from("rides").select("driver_id, needs_driver").eq("id", ride.id).single()).data)
      .toEqual({ driver_id: PROFILE_IDS.member1, needs_driver: false });
    await expect(page.getByTestId("ride-offer-has-driver")).toHaveText(he.driverWanted.taken);
    await member1.context.close();
  } finally {
    await removeWeek(service, week);
  }
});
