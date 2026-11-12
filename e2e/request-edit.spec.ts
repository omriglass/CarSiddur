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
//  - OW1 (REQ §13.210): a change to one way that would leave the car at the destination asks, then goes through;
//  - REQ §13.158: a time change no car takes is refused ("אין רכב פנוי בשעות החדשות") and leaves everything as it was —
//    an edit never costs the car.
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

  // Owner 2026-11-09: a named child is not in the payload's seat counts, so adding one leaves the request row as it was —
  // the server answers `unchanged`, and the child must still be saved (it was dropped with "no changes").
  test("adding a child to a request saves the child although the request row is unchanged", async ({ page }) => {
    const service = serviceRoleClient();
    const week = await memberOpenWeek();
    let requestId: string | undefined;
    const { data: child, error } = await service.from("children").insert({ department_id: NEVO_DEPARTMENT_ID, full_name: "ילדת בדיקה" }).select("id").single();
    if (error) throw error;
    try {
      await service.from("child_guardians").insert({ child_id: child!.id, profile_id: PROFILE_IDS.member1 });
      requestId = await insertRequest(service, dayOfWeek(week.weekStart, 5), {
        week: week.weekStart, requester: PROFILE_IDS.member1, depart: "09:00", return: "12:00", destinationId: PLACES.haifa.id,
      });
      await signIn(page, SEEDED_USERS.member1);
      await page.goto(paths.requests.edit(requestId));
      const sentence = page.getByTestId("request-sentence");
      await expect(sentence.getByTestId("chip-destination")).toContainText(PLACES.haifa.name);
      await sentence.getByTestId("chip-who").click();
      await page.getByTestId(`who-child-${child!.id}`).click();
      await page.getByRole("button", { name: he.requestSentence.sheetDone }).click();
      await expect(sentence.getByTestId("chip-who")).toContainText("ילדת בדיקה");
      await saveEditedRequest(page);
      await expect(page.getByText(he.request.noChanges)).toHaveCount(0);
      await expect.poll(async () => (await service.from("request_children").select("child_id").eq("request_id", requestId!)).data?.map((row) => row.child_id)).toEqual([child!.id]);
    } finally {
      if (requestId) await deleteRequests(service, [requestId]);
      await service.from("children").delete().eq("id", child!.id);
      await week.cleanup();
    }
  });

  test("published day: a note-only edit keeps the booking, a time change no car takes is refused, one way asks", async ({ page }) => {
    const service = serviceRoleClient();
    const week = FIXTURE_WEEKS.publishedEdit;
    const day = dayOfWeek(week, 1);
    const admin = await publishedFixtureWeek(week);
    await admin.auth.signOut();
    let requestId: string | undefined;
    let rideId: string | undefined;
    const blockerIds: string[] = [];
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

      await test.step("a time change no car takes is refused; nothing changes", async () => {
        // every shared car is taken 08:00-09:30, so leaving at 09:00 fits none (the member's own car included)
        const { data: cars, error: carsError } = await service.from("cars").select("id")
          .eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active");
        if (carsError) throw carsError;
        for (const car of cars ?? []) {
          const { data: blocker, error: blockerError } = await service.from("rides").insert({
            department_id: NEVO_DEPARTMENT_ID, week_start: week, car_id: car.id as string, driver_id: PROFILE_IDS.sadran, created_by: PROFILE_IDS.sadran,
            starts_at: winterAt(day, "08:00"), ends_at: winterAt(day, "09:30"), blocked_until: winterAt(day, "09:30"),
            origin_id: PLACES.home.id, destination_id: PLACES.home.id, status: "confirmed", notes: "E2E edit refusal blocker",
          }).select("id").single();
          if (blockerError) throw blockerError;
          blockerIds.push(blocker.id as string);
        }
        await page.goto(paths.requests.edit(requestId as string));
        await expect(page.getByTestId("request-sentence")).toBeVisible();
        await page.getByTestId("chip-out").click();
        await fillTimeField(page.getByTestId("time-sheet-out"), he.field.depart, "09:00");
        await page.getByRole("button", { name: he.requestSentence.sheetDone, exact: true }).click();
        await saveEditedRequest(page);

        const refusal = page.getByRole("dialog").filter({ hasText: he.request.editRefusedTitle });
        await expect(refusal).toBeVisible();
        await expect(refusal).toContainText(he.request.editRefusedBody);
        await refusal.getByRole("button", { name: he.request.editRefusedBack, exact: true }).click();
        await expect(refusal).toHaveCount(0);
        // back on the form (still editing), nothing saved
        await expect(page).toHaveURL(new RegExp(`/requests/${requestId}/edit`));

        const { data: request } = await service.from("requests").select("status, depart_at").eq("id", requestId as string).single();
        expect(request!.status).toBe("assigned");
        expect(jerusalemTime(request!.depart_at as string)).toBe("10:00");
        const { data: links } = await service.from("ride_requests").select("ride_id").eq("request_id", requestId as string);
        expect(links).toEqual([{ ride_id: rideId }]);
      });

      await test.step("OW1 (REQ §13.210): a change to one way asks, then leaves the car at the destination", async () => {
        await service.from("rides").delete().in("id", blockerIds);
        blockerIds.length = 0;
        await page.goto(paths.requests.edit(requestId as string));
        const sentence = page.getByTestId("request-sentence");
        await expect(sentence).toBeVisible();
        await sentence.getByTestId("chip-trip").click();
        await page.getByRole("radio", { name: he.request.tripTypeOneWay, exact: true }).click();
        const done = page.getByRole("button", { name: he.requestSentence.sheetDone, exact: true });
        await done.waitFor({ state: "visible", timeout: 2_000 }).then(() => done.click(), () => undefined);
        await saveEditedRequest(page);

        const ask = page.getByRole("dialog").filter({ hasText: he.request.carStaysAwayTitle });
        await expect(ask).toBeVisible();
        const { data: untouched } = await service.from("requests").select("trip_type").eq("id", requestId as string).single();
        expect(untouched!.trip_type).toBe("round_trip");
        await ask.getByRole("button", { name: he.request.carStaysAwayConfirm, exact: true }).click();

        await expect(page).toHaveURL(/\/my$/);
        const { data: request } = await service.from("requests").select("status, trip_type").eq("id", requestId as string).single();
        expect(request).toMatchObject({ status: "assigned", trip_type: "one_way" });
        const { data: rides } = await service.from("rides").select("car_id, destination_id, status, ride_requests!inner(request_id)")
          .eq("ride_requests.request_id", requestId as string).neq("status", "cancelled");
        expect(rides).toHaveLength(1);
        expect(rides![0]).toMatchObject({ car_id: carId, destination_id: PLACES.haifa.id });
      });
    } finally {
      if (blockerIds.length > 0) await service.from("rides").delete().in("id", blockerIds);
      if (requestId) await deleteRequests(service, [requestId]);
      // The empty publication snapshot is immutable, so the week row itself may stay behind; its rows are removed.
      await removeWeek(service, week);
    }
  });
});
