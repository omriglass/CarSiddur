import { expect, test } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, signIn } from "./helpers";
import { publishedFixtureWeek } from "./published-week";
import {
  dayOfWeek, FIXTURE_WEEKS, fillTimeField, insertRequest, PLACES, PROFILE_IDS, removeWeek, reserveCar, saveEditedRequest, setClassicForm,
  sharedCarIdByName, winterAt,
} from "./request-form";

// DP1-1 (production 26.11): the Sadran edits a member's waiting request, no car is free, and the form offers
// "לצרף לנסיעה של…". Joining puts the request's own people on that ride — the member, never the Sadran who pressed it.
test.use({ viewport: { width: 390, height: 844 } });

test.describe("joining a ride from someone else's request", { tag: ["@request-form", "@waitlist"] }, () => {
  test.beforeEach(async () => { await setClassicForm(SEEDED_USERS.sadran.email, false); });
  test.afterEach(async () => { await setClassicForm(SEEDED_USERS.sadran.email, true); });

  test("the Sadran's join adds the requester, not the Sadran", async ({ page }) => {
    const service = serviceRoleClient();
    const week = FIXTURE_WEEKS.joinForOther;
    const day = dayOfWeek(week, 2);
    const admin = await publishedFixtureWeek(week);
    await admin.auth.signOut();
    try {
      // member2 drives to Haifa 10:00–12:00 with free seats; every other shared car is taken all day
      const hostCar = await sharedCarIdByName(service, "יונדאי 1");
      const hostRequest = await insertRequest(service, day, {
        week, requester: PROFILE_IDS.member2, depart: "10:00", return: "12:00", destinationId: PLACES.haifa.id, status: "assigned",
        extra: { origin_id: PLACES.home.id },
      });
      const { data: ride, error: rideError } = await service.from("rides").insert({
        department_id: NEVO_DEPARTMENT_ID, week_start: week, car_id: hostCar, driver_id: PROFILE_IDS.member2, created_by: PROFILE_IDS.member2,
        starts_at: winterAt(day, "10:00"), ends_at: winterAt(day, "12:00"), blocked_until: winterAt(day, "12:30"),
        origin_id: PLACES.home.id, destination_id: PLACES.home.id, status: "confirmed",
      }).select("id").single();
      if (rideError) throw rideError;
      const { error: linkError } = await service.from("ride_requests").insert({ ride_id: ride.id, request_id: hostRequest, role: "driver", leg: "both", car_mode: "keep" });
      if (linkError) throw linkError;
      const { data: cars, error: carsError } = await service.from("cars").select("id")
        .eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active").neq("id", hostCar);
      if (carsError) throw carsError;
      for (const car of cars ?? []) await reserveCar(service, week, car.id as string, day, "06:00", "20:00");
      // member1's waiting request to Haifa at the same hours
      const requestId = await insertRequest(service, day, {
        week, requester: PROFILE_IDS.member1, depart: "10:00", return: "12:00", destinationId: PLACES.haifa.id, status: "waitlisted",
        extra: { origin_id: PLACES.home.id },
      });

      await signIn(page, SEEDED_USERS.sadran);
      await page.goto(paths.requests.edit(requestId));
      await expect(page.getByTestId("request-sentence")).toBeVisible();

      await test.step("an edit that finds no car offers the ride with free seats", async () => {
        await page.getByTestId("chip-out").click();
        await fillTimeField(page.getByTestId("time-sheet-out"), he.field.depart, "10:15");
        await page.getByRole("button", { name: he.requestSentence.sheetDone, exact: true }).click();
        await saveEditedRequest(page);
        await expect(page.getByRole("dialog").filter({ hasText: he.joinableRides.title })).toBeVisible();
      });

      await test.step("joining puts the member on the ride, not the Sadran", async () => {
        await page.getByRole("dialog").filter({ hasText: he.joinableRides.title })
          .getByRole("button", { name: he.joinableRides.askToJoin, exact: true }).click();
        await expect.poll(async () => (await service.from("ride_passengers").select("person_id").eq("ride_id", ride.id as string)).data
          ?.map((p) => p.person_id)).toEqual([PROFILE_IDS.member1]);
      });
    } finally {
      await removeWeek(service, week);
    }
  });
});
