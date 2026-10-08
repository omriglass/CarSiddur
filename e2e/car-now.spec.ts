import { expect, test } from "@playwright/test";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import { he } from "../src/i18n/he";
import { getWeekStart, NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, signIn } from "./helpers";
import { dayOfWeek, deleteRequests, PLACES, PROFILE_IDS, setClassicForm, TZ } from "./request-form";

// REQ §13.74, §13.110: "רוצה רכב עכשיו!" on /my in the sentence layout. The card opens the one-stage car-now sheet
// (who chip, destination, how long); submitting auto-approves a ride that starts now on the free car, like a round trip
// on a free car in the live week. "Now" is pinned (page clock) to a day of the live week with a free car, so the run does not
// depend on the wall clock (car-now only counts free time inside the day window). No seeded ride is touched.
test.use({ viewport: { width: 390, height: 844 } });

test.describe("car now, sentence layout", { tag: ["@quick-request"] }, () => {
  test.beforeEach(async () => { await setClassicForm(SEEDED_USERS.member2.email, false); });
  test.afterEach(async () => { await setClassicForm(SEEDED_USERS.member2.email, true); });

  test("the card on /my files today's ride on the free car", async ({ page }) => {
    test.slow();
    const service = serviceRoleClient();
    const liveWeek = await getWeekStart("live");
    const { data: sharedCars } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active");
    const carIds = (sharedCars ?? []).map((car) => car.id as string);
    // Pick a day of the live week on which at least one shared car has no ride around noon. Nothing is parked or
    // cancelled: moving seeded rides would release their requests and leave the shared live week changed for other specs.
    let day = "";
    let now = new Date();
    for (let index = 0; index < 7 && !day; index += 1) {
      const candidate = dayOfWeek(liveWeek, index);
      const noon = fromZonedTime(`${candidate} 12:00:00`, TZ);
      const from = new Date(noon.getTime() - 90 * 60_000).toISOString();
      const to = new Date(noon.getTime() + 6 * 3600_000).toISOString();
      const { data: busy } = await service.from("rides").select("car_id").in("car_id", carIds).neq("status", "cancelled").lt("starts_at", to).gt("ends_at", from);
      const busyCars = new Set((busy ?? []).map((ride) => ride.car_id as string));
      if (carIds.some((id) => !busyCars.has(id))) { day = candidate; now = noon; }
    }
    expect(day, "a day of the live week with a free shared car around noon").not.toBe("");
    const startedAt = new Date().toISOString();
    let requestId: string | undefined;
    try {
      await signIn(page, SEEDED_USERS.member2);
      await page.clock.setFixedTime(now);
      await page.goto("/my");

      await test.step("the card is enabled and opens the car-now sheet on the destination", async () => {
        const card = page.getByText(he.quickRequest.takeCarNow, { exact: true });
        await expect(card).toBeVisible();
        await card.click();
        await expect(page.getByTestId("request-sentence")).toBeVisible();
        await expect(page.getByPlaceholder(he.requestSentence.placeSearch)).toBeVisible();
        // one stage: no "המשך" button, the submit button is already there once a place is chosen
        await expect(page.getByTestId("stage-next")).toHaveCount(0);
      });

      await test.step("pick the destination and take the car", async () => {
        await page.getByPlaceholder(he.requestSentence.placeSearch).fill(PLACES.haifa.name);
        await page.getByRole("option").filter({ hasText: PLACES.haifa.name }).first().click();
        await expect(page.getByTestId("chip-destination")).toContainText(PLACES.haifa.name);
        await expect(page.getByTestId("car-now-return")).toBeVisible();
        await page.getByRole("button", { name: he.quickRequest.submit, exact: true }).click();
        await expect(page.getByText(/הרכב שלך/).first()).toBeVisible({ timeout: 15_000 });
      });

      await test.step("a ride that starts now exists today, assigned to the requester", async () => {
        const { data: request, error } = await service.from("requests").select("id, status, depart_at, return_at, requester_id")
          .eq("requester_id", PROFILE_IDS.member2).eq("week_start", liveWeek).eq("destination_id", PLACES.haifa.id).gte("created_at", startedAt)
          .order("created_at", { ascending: false }).limit(1).single();
        if (error) throw error;
        requestId = request.id as string;
        expect(request.status).toBe("assigned");
        expect(formatInTimeZone(new Date(request.depart_at as string), TZ, "yyyy-MM-dd HH:mm")).toBe(`${day} 12:00`);
        const { data: links } = await service.from("ride_requests").select("ride_id").eq("request_id", requestId);
        expect(links).toHaveLength(1);
        const { data: ride } = await service.from("rides").select("status, starts_at, driver_id").eq("id", links![0]!.ride_id as string).single();
        expect(ride).toMatchObject({ driver_id: PROFILE_IDS.member2 });
        expect(ride!.status).not.toBe("cancelled");
        expect(formatInTimeZone(new Date(ride!.starts_at as string), TZ, "yyyy-MM-dd HH:mm")).toBe(`${day} 12:00`);
      });
    } finally {
      if (requestId) await deleteRequests(service, [requestId]);
    }
  });
});
