import { expect, test } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he, tv } from "../src/i18n/he";
import { SEEDED_USERS, serviceRoleClient, signIn, submitRequestForm } from "./helpers";
import {
  chooseDestination, dayMonthLabel, dayOfWeek, deleteRequests, fillTimeField, jerusalemTime, memberOpenWeek, PLACES, PROFILE_IDS,
  saveEditedRequest, setClassicForm,
} from "./request-form";

// REQ §13.112 (c), UX_FLOWS §3.4a "Time window": "יש לי חלון זמן?" turns the time part of the sentence into
// "ל[3 שעות] בין [07:00] ל[12:00]"; stored as the earliest block + later-only flexibility + `duration_locked`;
// `/my` says "3 שעות בין 07:00 ל־12:00"; an edit reopens in window mode.
test.use({ viewport: { width: 390, height: 844 } });

test.describe("request time window", { tag: ["@request-form"] }, () => {
  test.beforeEach(async () => { await setClassicForm(SEEDED_USERS.member1.email, false); });
  test.afterEach(async () => { await setClassicForm(SEEDED_USERS.member1.email, true); });

  test("files a 3-hour window, /my states it, and the edit reopens in window mode", async ({ page }) => {
    const service = serviceRoleClient();
    const week = await memberOpenWeek();
    const marker = `E2E window ${Date.now()}`;
    const day = dayOfWeek(week.weekStart, 4);
    const summary = tv("requestSentence.window.summary", { hours: tv("requestSentence.window.hours", { n: "3" }), start: "07:00", end: "12:00" });
    let requestId: string | undefined;
    try {
      await signIn(page, SEEDED_USERS.member1);
      await page.goto(paths.requests.new({ week: week.weekStart, day }));
      await expect(page.getByTestId("chip-day")).toContainText(dayMonthLabel(day));
      await chooseDestination(page, PLACES.haifa.name);

      await test.step("switch to a window and set 3 hours between 07:00 and 12:00", async () => {
        await page.getByTestId("window-link").click();
        await expect(page.getByTestId("chip-window-hours")).toBeVisible();
        // The fixed time chips are replaced by the window chips.
        await expect(page.getByTestId("chip-out")).toHaveCount(0);

        await page.getByTestId("chip-window-hours").click();
        await page.getByTestId("window-hours-3").click();
        await page.getByRole("button", { name: he.requestSentence.sheetDone, exact: true }).click();

        await page.getByTestId("chip-window-start").click();
        await fillTimeField(page.getByTestId("window-start-sheet"), he.requestSentence.window.startAria, "07:00");
        await page.getByRole("button", { name: he.requestSentence.sheetDone, exact: true }).click();

        await page.getByTestId("chip-window-end").click();
        await fillTimeField(page.getByTestId("window-end-sheet"), he.requestSentence.window.endAria, "12:00");
        await page.getByRole("button", { name: he.requestSentence.sheetDone, exact: true }).click();

        await expect(page.getByTestId("chip-window-hours")).toContainText(tv("requestSentence.window.hours", { n: "3" }));
        await expect(page.getByTestId("chip-window-start")).toContainText("07:00");
        await expect(page.getByTestId("chip-window-end")).toContainText("12:00");

        await page.getByTestId("stage-one-notes").getByTestId("row-description").getByRole("button").click();
        await page.getByRole("textbox", { name: he.requestSentence.description }).fill(marker);
      });

      await test.step("stage 2 recap names the window; submit", async () => {
        await page.getByTestId("stage-next").click();
        await expect(page.getByTestId("recap-when")).toContainText(summary);
        await submitRequestForm(page);
        await expect(page).toHaveURL(/\/my$/);
      });

      await test.step("stored as the earliest block, later-only flexibility and a locked length", async () => {
        const { data: row, error } = await service.from("requests")
          .select("id, depart_at, return_at, duration_locked, flex_depart_early, flex_depart_late, flex_return_early, flex_return_late")
          .eq("requester_id", PROFILE_IDS.member1).eq("ride_description", marker).single();
        if (error) throw error;
        requestId = row.id as string;
        expect(row.duration_locked).toBe(true);
        expect(jerusalemTime(row.depart_at as string)).toBe("07:00");
        expect(jerusalemTime(row.return_at as string)).toBe("10:00");
        // slack = window end (12:00) minus the earliest block end (10:00), later only
        expect(row.flex_depart_early).toBe("00:00:00");
        expect(row.flex_return_early).toBe("00:00:00");
        expect(row.flex_depart_late).toBe("02:00:00");
        expect(row.flex_return_late).toBe("02:00:00");
      });

      await test.step("/my shows the window summary", async () => {
        await expect(page.locator(`[data-request-id="${requestId}"]`).getByTestId("request-window")).toContainText(summary);
      });

      await test.step("the edit reopens in window mode and an untouched save changes nothing", async () => {
        await page.goto(paths.requests.edit(requestId as string));
        await expect(page.getByTestId("chip-window-hours")).toContainText(tv("requestSentence.window.hours", { n: "3" }));
        await expect(page.getByTestId("chip-window-start")).toContainText("07:00");
        await expect(page.getByTestId("chip-window-end")).toContainText("12:00");
        await expect(page.getByTestId("window-link")).toHaveText(he.requestSentence.window.backToFixed);
        const { data: before } = await service.from("requests").select("version").eq("id", requestId as string).single();
        await saveEditedRequest(page);
        await expect(page.getByText(he.request.noChanges)).toBeVisible();
        const { data: after } = await service.from("requests").select("version, duration_locked").eq("id", requestId as string).single();
        expect(after).toMatchObject({ version: before!.version, duration_locked: true });
      });
    } finally {
      if (requestId) await deleteRequests(service, [requestId]);
      else await service.from("requests").delete().eq("requester_id", PROFILE_IDS.member1).eq("ride_description", marker);
      await week.cleanup();
    }
  });
});
