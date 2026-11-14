import { expect, test } from "@playwright/test";

import { paths } from "../src/app/routes";
import { t, tv } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, signIn } from "./helpers";
import { publishedFixtureWeek } from "./published-week";
import {
  dayOfWeek, deleteRequests, FIXTURE_WEEKS, insertRequest, jerusalemTime, PLACES, PROFILE_IDS, removeWeek, saveEditedRequest, sharedCarIdByName, winterAt,
} from "./request-form";

// MD1 (owner 2026-11-14, REQ item 232): editing a booked one-day ride into a multi-day one. The car must stay the same
// for the whole span; the member's own ride on day 2 blocks it, and the question offers to replace that ride — with two
// buttons when it ends after the new return ("להחליף ולחזור ב־14:00" / "…ב־12:00").
test.use({ viewport: { width: 390, height: 844 } });

test.describe("one-day ride to multi-day", { tag: ["@request-form"] }, () => {
  test("own ride on day 2: replace it and keep its later end", async ({ page }) => {
    const service = serviceRoleClient();
    const week = FIXTURE_WEEKS.multiDayEdit;
    const day1 = dayOfWeek(week, 1);
    const day2 = dayOfWeek(week, 2);
    const admin = await publishedFixtureWeek(week);
    await admin.auth.signOut();
    const requestIds: string[] = [];
    try {
      const carId = await sharedCarIdByName(service, "יונדאי 1");
      const ride = async (requestId: string, day: string, from: string, to: string, until: string) => {
        const { data, error } = await service.from("rides").insert({
          department_id: NEVO_DEPARTMENT_ID, week_start: week, car_id: carId, driver_id: PROFILE_IDS.member1, created_by: PROFILE_IDS.member1,
          starts_at: winterAt(day, from), ends_at: winterAt(day, to), blocked_until: winterAt(day, until),
          origin_id: PLACES.home.id, destination_id: PLACES.home.id, status: "confirmed",
        }).select("id").single();
        if (error) throw error;
        const { error: linkError } = await service.from("ride_requests").insert({ ride_id: data.id, request_id: requestId, role: "driver", leg: "both", car_mode: "keep" });
        if (linkError) throw linkError;
        return data.id as string;
      };
      const oneDay = await insertRequest(service, day1, {
        week, requester: PROFILE_IDS.member1, depart: "10:00", return: "12:00", destinationId: PLACES.haifa.id, status: "assigned",
      });
      requestIds.push(oneDay);
      await ride(oneDay, day1, "10:00", "12:00", "12:30");
      const own = await insertRequest(service, day2, {
        week, requester: PROFILE_IDS.member1, depart: "08:00", return: "14:00", destinationId: PLACES.haifa.id, status: "assigned",
      });
      requestIds.push(own);
      const ownRide = await ride(own, day2, "08:00", "14:00", "14:30");

      await signIn(page, SEEDED_USERS.member1);
      await page.goto(paths.requests.edit(oneDay));
      await page.getByRole("button", { name: t("request.returnAnotherDay"), exact: true }).click();
      const returnPicker = page.getByRole("radiogroup", { name: t("request.returnDay") });
      await returnPicker.getByRole("radio").first().click();       // the next day, Tuesday (return 12:00 kept)
      await saveEditedRequest(page);

      const question = page.getByRole("dialog").filter({ has: page.getByTestId("series-car-taken") });
      await expect(question).toBeVisible();
      await expect(question).toContainText(tv("request.carTakenOwnMine", { day: "ג׳ 14.3", time: "08:00" }));
      await expect(question.getByTestId("series-replace-later")).toHaveText(tv("request.carTakenReplaceReturn", { time: "14:00" }));
      await expect(question.getByTestId("series-replace-new")).toHaveText(tv("request.carTakenReplaceReturn", { time: "12:00" }));
      await expect(question.getByTestId("series-return-earlier")).toHaveText(tv("request.carTakenReturnEarlier", { time: "07:30" }));
      await question.getByTestId("series-replace-later").click();
      await expect(page).toHaveURL(/\/my$/);

      const { data: replaced } = await service.from("requests").select("id, status").in("id", [oneDay, own]);
      expect(replaced?.every((r) => r.status === "withdrawn")).toBe(true);
      const { data: cancelled } = await service.from("rides").select("status").eq("id", ownRide).single();
      expect(cancelled!.status).toBe("cancelled");
      const { data: legs } = await service.from("requests").select("id, series_index, status, return_at")
        .eq("requester_id", PROFILE_IDS.member1).eq("week_start", week).not("series_id", "is", null).neq("status", "withdrawn").order("series_index");
      requestIds.push(...(legs ?? []).map((l) => l.id as string));
      expect(legs?.map((l) => l.status)).toEqual(["assigned", "assigned"]);
      expect(jerusalemTime(legs![1]!.return_at as string)).toBe("14:00");
      const { data: links } = await service.from("ride_requests").select("rides!inner(car_id, status)").in("request_id", (legs ?? []).map((l) => l.id as string));
      expect((links ?? []).every((l) => (l.rides as unknown as { car_id: string }).car_id === carId)).toBe(true);
    } finally {
      await deleteRequests(service, requestIds);
      await removeWeek(service, week);
    }
  });
});
