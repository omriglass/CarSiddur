import { expect, test } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, signIn } from "./helpers";
import { publishedFixtureWeek } from "./published-week";
import {
  dayOfWeek, FIXTURE_WEEKS, fillTimeField, insertRequest, PLACES, PROFILE_IDS, removeWeek, saveEditedRequest, setClassicForm,
  sharedCarIdByName, winterAt,
} from "./request-form";

// REQ §13.169: with the department's "כל אחד/ת יכול/ה לערוך כל נסיעה" on, a member opens someone else's ride on the
// siddur, edits it in the sentence form and moves it to another rider who drives; the requester gets one merged
// `ride_edited` notice listing both changes.
test.use({ viewport: { width: 390, height: 844 } });

test.describe("anyone edits rides", { tag: ["@request-form", "@notifications"] }, () => {
  test.beforeEach(async () => { await setClassicForm(SEEDED_USERS.member1.email, false); });
  test.afterEach(async () => { await setClassicForm(SEEDED_USERS.member1.email, true); });

  test("a member edits another member's ride; the requester gets one notice", async ({ page }) => {
    const service = serviceRoleClient();
    const week = FIXTURE_WEEKS.anyoneEdits;
    const day = dayOfWeek(week, 2);
    const admin = await publishedFixtureWeek(week);
    await admin.auth.signOut();
    let requestId: string | undefined;
    try {
      await service.from("department_settings").update({ anyone_edits_rides: true }).eq("department_id", NEVO_DEPARTMENT_ID);
      const carId = await sharedCarIdByName(service, "יונדאי 1");
      // member2's ride with the Sadran as a named rider (both drive)
      requestId = await insertRequest(service, day, {
        week, requester: PROFILE_IDS.member2, depart: "10:00", return: "12:00", destinationId: PLACES.haifa.id, status: "assigned",
        extra: { adults: 2 },
      });
      await service.from("request_companions").insert({ request_id: requestId, profile_id: PROFILE_IDS.sadran });
      const { data: ride, error: rideError } = await service.from("rides").insert({
        department_id: NEVO_DEPARTMENT_ID, week_start: week, car_id: carId, driver_id: PROFILE_IDS.member2, created_by: PROFILE_IDS.member2,
        starts_at: winterAt(day, "10:00"), ends_at: winterAt(day, "12:00"), blocked_until: winterAt(day, "12:30"),
        origin_id: PLACES.home.id, destination_id: PLACES.home.id, status: "confirmed",
      }).select("id").single();
      if (rideError) throw rideError;
      await service.from("ride_requests").insert({ ride_id: ride.id, request_id: requestId, role: "driver", leg: "both", car_mode: "keep" });
      await service.from("notifications").delete().eq("recipient_id", PROFILE_IDS.member2).eq("event", "ride_edited");

      await signIn(page, SEEDED_USERS.member1);
      await page.goto(paths.siddur({ dept: NEVO_DEPARTMENT_ID, week, rideId: ride.id as string }));

      await test.step("the ride sheet offers the edit to a member who is not on the ride", async () => {
        await page.getByTestId("ride-edit-request").click();
        await expect(page).toHaveURL(new RegExp(`/requests/${requestId}/edit`));
        await expect(page.getByTestId("request-sentence")).toBeVisible();
      });

      await test.step("an hours change is saved and told to the requester", async () => {
        await page.getByTestId("chip-out").click();
        await fillTimeField(page.getByTestId("time-sheet-out"), he.field.depart, "11:00");
        await page.getByRole("button", { name: he.requestSentence.sheetDone, exact: true }).click();
        await saveEditedRequest(page);
        await expect.poll(async () => (await service.from("notifications").select("body_he")
          .eq("recipient_id", PROFILE_IDS.member2).eq("event", "ride_edited").is("read_at", null)).data?.map((n) => n.body_he))
          .toEqual([expect.stringContaining("יציאה 11:00 במקום 10:00")]);
      });

      await test.step("the who chip moves the request to the other driving rider", async () => {
        await page.goto(paths.requests.edit(requestId as string));
        await expect(page.getByTestId("request-sentence")).toBeVisible();
        await page.getByTestId("chip-who").click();
        await page.getByTestId(`who-driver-${PROFILE_IDS.sadran}`).click();
        await page.getByTestId("who-dialog").getByRole("button", { name: he.requestSentence.sheetDone, exact: true }).click();
        await saveEditedRequest(page);
        const confirm = page.getByRole("dialog").filter({ hasText: he.request.moveRequesterConfirm });
        await confirm.getByRole("button", { name: he.request.moveRequesterConfirm, exact: true }).click();

        await expect.poll(async () => (await service.from("requests").select("requester_id").eq("id", requestId as string).single()).data?.requester_id)
          .toBe(PROFILE_IDS.sadran);
        // the form saves the companions by their own call after the request
        await expect.poll(async () => (await service.from("request_companions").select("profile_id").eq("request_id", requestId as string)).data)
          .toEqual([{ profile_id: PROFILE_IDS.member2 }]);
        // still one unread notice for member2, now listing both changes
        await expect.poll(async () => (await service.from("notifications").select("body_he")
          .eq("recipient_id", PROFILE_IDS.member2).eq("event", "ride_edited").is("read_at", null)).data?.map((n) => n.body_he))
          .toEqual([expect.stringMatching(/יציאה 11:00 במקום 10:00.*נהג\/ת: סדרן נבו במקום חברה שנייה/)]);
      });
    } finally {
      await service.from("department_settings").update({ anyone_edits_rides: false }).eq("department_id", NEVO_DEPARTMENT_ID);
      if (requestId) await service.from("notifications").delete().eq("event", "ride_edited").eq("data->>request_id", requestId);
      await removeWeek(service, week);
    }
  });
});
