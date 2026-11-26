import { expect, test } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, signIn } from "./helpers";
import { publishedFixtureWeek } from "./published-week";
import {
  dayOfWeek, FIXTURE_WEEKS, insertRequest, PLACES, PROFILE_IDS, removeWeek, reserveCar, saveEditedRequest, setClassicForm, sharedCarIdByName, winterAt,
} from "./request-form";

// DP1-5 (production 30.11): אלי rode in אביב's ride with עומר as her companion and took him off her request. The save
// was handled as a new trip and refused for lack of a car. Fewer people keep the seat in the same ride.
test.use({ viewport: { width: 390, height: 844 } });

test.describe("a guest who takes people off their request", { tag: ["@request-form", "@ride-passengers"] }, () => {
  test.beforeEach(async () => { await setClassicForm(SEEDED_USERS.member1.email, false); });
  test.afterEach(async () => { await setClassicForm(SEEDED_USERS.member1.email, true); });

  test("stays in the ride with one seat fewer", async ({ page }) => {
    const service = serviceRoleClient();
    const week = FIXTURE_WEEKS.guestFewerPeople;
    const day = dayOfWeek(week, 2);
    const admin = await publishedFixtureWeek(week);
    await admin.auth.signOut();
    try {
      // member2 drives to Haifa 10:00–12:00; member1 rides in it with the admin as her companion; every other car is taken
      const hostCar = await sharedCarIdByName(service, "יונדאי 1");
      const hostRequest = await insertRequest(service, day, {
        week, requester: PROFILE_IDS.member2, depart: "10:00", return: "12:00", destinationId: PLACES.haifa.id, status: "assigned",
        extra: { origin_id: PLACES.home.id },
      });
      const guestRequest = await insertRequest(service, day, {
        week, requester: PROFILE_IDS.member1, depart: "10:00", return: "12:00", destinationId: PLACES.haifa.id, status: "merged",
        extra: { origin_id: PLACES.home.id, adults: 2 },
      });
      const { error: companionError } = await service.from("request_companions").insert({ request_id: guestRequest, profile_id: PROFILE_IDS.admin });
      if (companionError) throw companionError;
      const { data: ride, error: rideError } = await service.from("rides").insert({
        department_id: NEVO_DEPARTMENT_ID, week_start: week, car_id: hostCar, driver_id: PROFILE_IDS.member2, created_by: PROFILE_IDS.sadran,
        starts_at: winterAt(day, "10:00"), ends_at: winterAt(day, "12:00"), blocked_until: winterAt(day, "12:30"),
        origin_id: PLACES.home.id, destination_id: PLACES.home.id, status: "confirmed",
      }).select("id").single();
      if (rideError) throw rideError;
      const { error: linkError } = await service.from("ride_requests").insert([
        { ride_id: ride.id, request_id: hostRequest, role: "driver", leg: "both", car_mode: "keep" },
        { ride_id: ride.id, request_id: guestRequest, role: "passenger", leg: "both", car_mode: "passenger" },
      ]);
      if (linkError) throw linkError;
      const { data: cars, error: carsError } = await service.from("cars").select("id")
        .eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active").neq("id", hostCar);
      if (carsError) throw carsError;
      for (const car of cars ?? []) await reserveCar(service, week, car.id as string, day, "06:00", "20:00");

      await signIn(page, SEEDED_USERS.member1);
      await page.goto(paths.requests.edit(guestRequest));
      await expect(page.getByTestId("request-sentence")).toBeVisible();

      await test.step("she takes her companion off and saves", async () => {
        await page.getByTestId("chip-who").click();
        await page.getByTestId(`who-member-${PROFILE_IDS.admin}`).click();
        await expect(page.getByTestId(`who-member-${PROFILE_IDS.admin}`)).toHaveAttribute("aria-pressed", "false");
        await page.getByRole("button", { name: he.requestSentence.sheetDone, exact: true }).click();
        await saveEditedRequest(page);
      });

      await test.step("she is still in the same ride, alone on her request", async () => {
        await expect.poll(async () => (await service.from("request_companions").select("profile_id").eq("request_id", guestRequest)).data?.length).toBe(0);
        const { data: request } = await service.from("requests").select("adults, status").eq("id", guestRequest).single();
        expect(request).toEqual({ adults: 1, status: "merged" });
        const { data: links } = await service.from("ride_requests").select("ride_id").eq("request_id", guestRequest);
        expect(links?.map((link) => link.ride_id)).toEqual([ride.id]);
        await expect(page.getByRole("dialog").filter({ hasText: he.joinableRides.title })).toHaveCount(0);
      });
    } finally {
      await removeWeek(service, week);
    }
  });
});
