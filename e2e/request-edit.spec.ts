import { expect, test } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, signIn } from "./helpers";
import { publishedFixtureWeek } from "./published-week";
import {
  dayOfWeek, deleteRequests, FIXTURE_WEEKS, fillTimeField, insertRequest, jerusalemTime, memberOpenWeek, PLACES, PROFILE_IDS,
  removeWeek, saveEditedRequest, setClassicForm, sharedCarIdByName, winterAt,
} from "./request-form";

// REQ §13.101 (f)/(h) (R11B1), §13.112 (e) "placement-neutral save": editing a request in the sentence form.
//  - a save that changes nothing is a no-op: toast "לא בוצעו שינויים", the version does not move;
//  - on a published day an assigned request edited only in its note keeps its ride and status (no "השינוי יוריד אותך מהרכב");
//  - a time change on the same request still asks the published-day confirmation, and "cancel" leaves everything as it was.
test.use({ viewport: { width: 390, height: 844 } });

test.describe("request edits", { tag: ["@request-form"] }, () => {
  test.beforeEach(async () => { await setClassicForm(SEEDED_USERS.member1.email, false); });
  test.afterEach(async () => { await setClassicForm(SEEDED_USERS.member1.email, true); });

  test("a save with no changes says so and leaves the version alone", async ({ page }) => {
    const service = serviceRoleClient();
    const week = await memberOpenWeek();
    let requestId: string | undefined;
    try {
      requestId = await insertRequest(service, dayOfWeek(week.weekStart, 5), {
        week: week.weekStart, requester: PROFILE_IDS.member1, depart: "09:00", return: "12:00", destinationId: PLACES.haifa.id,
      });
      const { data: before } = await service.from("requests").select("version, updated_at").eq("id", requestId).single();

      await signIn(page, SEEDED_USERS.member1);
      await page.goto(paths.requests.edit(requestId));
      await expect(page.getByTestId("request-sentence")).toBeVisible();
      await expect(page.getByTestId("chip-destination")).toContainText(PLACES.haifa.name);
      await saveEditedRequest(page);

      await expect(page.getByText(he.request.noChanges)).toBeVisible();
      const { data: after } = await service.from("requests").select("version, updated_at").eq("id", requestId).single();
      expect(after).toEqual(before);
    } finally {
      if (requestId) await deleteRequests(service, [requestId]);
      await week.cleanup();
    }
  });

  test("published day: a note-only edit keeps the booking, a time change asks for confirmation", async ({ page }) => {
    const service = serviceRoleClient();
    const week = FIXTURE_WEEKS.publishedEdit;
    const day = dayOfWeek(week, 1);
    const admin = await publishedFixtureWeek(week);
    await admin.auth.signOut();
    let requestId: string | undefined;
    let rideId: string | undefined;
    try {
      const carId = await sharedCarIdByName(service, "יונדאי 1");
      requestId = await insertRequest(service, day, {
        week, requester: PROFILE_IDS.member1, depart: "10:00", return: "12:00", destinationId: PLACES.haifa.id, status: "assigned",
      });
      const { data: ride, error: rideError } = await service.from("rides").insert({
        department_id: NEVO_DEPARTMENT_ID, week_start: week, car_id: carId, driver_id: PROFILE_IDS.member1, created_by: PROFILE_IDS.member1,
        starts_at: winterAt(day, "10:00"), ends_at: winterAt(day, "12:00"), blocked_until: winterAt(day, "12:30"),
        origin_id: PLACES.home.id, destination_id: PLACES.home.id, status: "confirmed",
      }).select("id").single();
      if (rideError) throw rideError;
      rideId = ride.id as string;
      const { error: linkError } = await service.from("ride_requests").insert({ ride_id: rideId, request_id: requestId, role: "driver", leg: "both", car_mode: "keep" });
      if (linkError) throw linkError;

      await signIn(page, SEEDED_USERS.member1);

      await test.step("a note-only edit is placement-neutral", async () => {
        const note = `E2E neutral note ${Date.now()}`;
        await page.goto(paths.requests.edit(requestId as string));
        await expect(page.getByTestId("request-sentence")).toBeVisible();
        await page.getByTestId("row-notes").getByRole("button").click();
        await page.getByRole("textbox", { name: he.requestSentence.note }).fill(note);
        await saveEditedRequest(page);

        await expect(page).toHaveURL(/\/my$/);
        await expect(page.getByText(he.request.loseBookingTitle)).toHaveCount(0);
        const { data: request } = await service.from("requests").select("status, notes, depart_at").eq("id", requestId as string).single();
        expect(request).toMatchObject({ status: "assigned", notes: note });
        expect(jerusalemTime(request!.depart_at as string)).toBe("10:00");
        const { data: links } = await service.from("ride_requests").select("ride_id").eq("request_id", requestId as string);
        expect(links).toEqual([{ ride_id: rideId }]);
        const { data: stillThere } = await service.from("rides").select("status, car_id").eq("id", rideId as string).single();
        expect(stillThere).toMatchObject({ status: "confirmed", car_id: carId });
      });

      await test.step("a time change asks before giving the car up; cancelling changes nothing", async () => {
        await page.goto(paths.requests.edit(requestId as string));
        await expect(page.getByTestId("request-sentence")).toBeVisible();
        await page.getByTestId("chip-out").click();
        await fillTimeField(page.getByTestId("time-sheet-out"), he.field.depart, "09:00");
        await page.getByRole("button", { name: he.requestSentence.sheetDone, exact: true }).click();
        await saveEditedRequest(page);

        const confirmation = page.getByRole("dialog").filter({ hasText: he.request.loseBookingTitle });
        await expect(confirmation).toBeVisible();
        await confirmation.getByRole("button", { name: he.common.cancel, exact: true }).click();
        await expect(confirmation).toHaveCount(0);

        const { data: request } = await service.from("requests").select("status, depart_at").eq("id", requestId as string).single();
        expect(request!.status).toBe("assigned");
        expect(jerusalemTime(request!.depart_at as string)).toBe("10:00");
        const { data: links } = await service.from("ride_requests").select("ride_id").eq("request_id", requestId as string);
        expect(links).toEqual([{ ride_id: rideId }]);
      });
    } finally {
      if (requestId) await deleteRequests(service, [requestId]);
      // The empty publication snapshot is immutable, so the week row itself may stay behind; its rows are removed.
      await removeWeek(service, week);
    }
  });
});
