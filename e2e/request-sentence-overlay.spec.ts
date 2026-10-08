import { expect, test } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he, tv } from "../src/i18n/he";
import { getWeekStart, NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, signIn, submitRequestForm } from "./helpers";
import {
  chooseDestination, dayMonthLabel, dayOfWeek, deleteRequests, fillTimeField, jerusalemTime, keepOnlyWeeks, memberOpenWeek,
  PLACES, PROFILE_IDS, setClassicForm,
} from "./request-form";

// REQ §13.110 (a)/(b), §13.112 (d), UX_FLOWS §3.4a: the sentence form opens as a card over the page the member came from
// (siddur), two stages, a who chip with a member companion + unnamed adults + unnamed children (stored seat counts), an
// "arrive by" time that derives the departure from the route minutes, and `?day=` preselecting the day.
// member2 is flipped to the sentence layout for the run (the suite default is the classic form, e2e/global-setup.ts).
const VIEWPORTS = [
  { name: "phone", size: { width: 390, height: 844 } },
  { name: "desktop", size: { width: 1280, height: 800 } },
] as const;

test.describe("request sentence overlay", { tag: ["@request-form"] }, () => {
  test.beforeEach(async () => { await setClassicForm(SEEDED_USERS.member2.email, false); });
  test.afterEach(async () => { await setClassicForm(SEEDED_USERS.member2.email, true); });

  for (const viewport of VIEWPORTS) {
    test(`${viewport.name}: card over the siddur, who + seats + arrive-by stored, closes back to the siddur`, async ({ page }) => {
      await page.setViewportSize(viewport.size);
      const service = serviceRoleClient();
      const week = await memberOpenWeek();
      const liveWeek = await getWeekStart("live");
      const marker = `E2E overlay ${viewport.name} ${Date.now()}`;
      const wednesday = dayOfWeek(week.weekStart, 3);
      let requestId: string | undefined;
      let estimatedDeparture = "";
      try {
        await keepOnlyWeeks(page, [liveWeek, week.weekStart]);
        await signIn(page, SEEDED_USERS.member2);

        await test.step("open the form from the siddur's new-request button", async () => {
          await page.goto(paths.siddur({ dept: NEVO_DEPARTMENT_ID, week: liveWeek }));
          await page.getByRole("link", { name: he.newRequestButton.nextWeek, exact: true }).first().click();
          await expect(page).toHaveURL(new RegExp(`/requests/new\\?week=${week.weekStart}`));
          const overlay = page.getByTestId("request-overlay");
          await expect(overlay).toBeVisible();
          await expect(page.getByTestId("request-sentence")).toBeVisible();
          // The siddur stays mounted underneath the card.
          await expect(page.locator('[data-testid^="siddur-week-switcher"]').first()).toBeAttached();
          const box = await overlay.boundingBox();
          expect(box).not.toBeNull();
          if (viewport.name === "desktop") expect(box!.width).toBeLessThan(viewport.size.width * 0.8);
          else expect(box!.y + box!.height).toBeGreaterThan(viewport.size.height - 4);
        });

        await test.step("stage 1: day, destination, who, arrive-by", async () => {
          await page.getByTestId("chip-day").click();
          await page.getByRole("radiogroup", { name: he.field.day }).first().getByRole("radio").nth(3).click();
          await page.getByRole("button", { name: he.requestSentence.sheetDone, exact: true }).click();
          await expect(page.getByTestId("chip-day")).toContainText(dayMonthLabel(wednesday));

          await chooseDestination(page, PLACES.haifa.name);

          await page.getByTestId("chip-who").click();
          const who = page.getByTestId("who-sheet");
          await page.getByTestId("who-add-member").click();
          await page.getByPlaceholder(he.requestSentence.whoMemberSearch).fill(SEEDED_USERS.member1.fullName);
          await page.getByRole("option", { name: SEEDED_USERS.member1.fullName }).click();
          await expect(page.getByTestId(`who-member-${PROFILE_IDS.member1}`)).toHaveAttribute("aria-pressed", "true");
          await who.getByRole("button", { name: he.requestSentence.whoExtraAdultsMore, exact: true }).click();
          await who.getByRole("button", { name: he.requestSentence.whoChildSeatsMore, exact: true }).click();
          await who.getByRole("button", { name: he.requestSentence.whoBoostersMore, exact: true }).click();
          await page.getByRole("button", { name: he.requestSentence.sheetDone, exact: true }).click();
          await expect(page.getByTestId("chip-who")).toContainText(SEEDED_USERS.member1.fullName);

          await page.getByTestId("chip-out").click();
          const sheet = page.getByTestId("time-sheet-out");
          await sheet.getByRole("radio", { name: he.requestSentence.anchor.outArrive }).click();
          await fillTimeField(sheet, he.field.depart, "09:30");
          const estimate = sheet.getByTestId("time-estimate-out");
          await expect(estimate).toBeVisible();
          // "יציאה משוערת 09:00 · 20 דק׳ נסיעה": the departure the form derived from the route minutes.
          estimatedDeparture = /(\d{1,2}:\d{2})/.exec(await estimate.innerText())?.[1] ?? "";
          expect(estimatedDeparture).not.toBe("");
          await page.getByRole("button", { name: he.requestSentence.sheetDone, exact: true }).click();
          await expect(page.getByTestId("chip-out")).toContainText(he.requestSentence.anchor.outArrive);

          await page.getByTestId("stage-one-notes").getByTestId("row-description").getByRole("button").click();
          await page.getByRole("textbox", { name: he.requestSentence.description }).fill(marker);
        });

        await test.step("stage 2 and submit: the card closes back to the siddur with the toast", async () => {
          await submitRequestForm(page);
          await expect(page).toHaveURL(new RegExp(`/siddur/${NEVO_DEPARTMENT_ID}/${liveWeek}`));
          await expect(page.getByTestId("request-overlay")).toHaveCount(0);
          await expect(page.getByText(he.request.submitSent)).toBeVisible();
        });

        await test.step("stored seats, companion and derived departure", async () => {
          const { data: row, error } = await service.from("requests")
            .select("id, adults, child_seats, boosters, depart_anchor, arrive_by, depart_at, return_at")
            .eq("requester_id", PROFILE_IDS.member2).eq("ride_description", marker).single();
          if (error) throw error;
          requestId = row.id as string;
          // requester + named companion + one unnamed adult; one unnamed child seat and one booster.
          expect(row).toMatchObject({ adults: 3, child_seats: 1, boosters: 1, depart_anchor: "arrive" });
          const { data: companions } = await service.from("request_companions").select("profile_id").eq("request_id", requestId);
          expect((companions ?? []).map((c) => c.profile_id)).toEqual([PROFILE_IDS.member1]);
          expect(jerusalemTime(row.arrive_by as string)).toBe("09:30");
          // departure = arrive-by minus the route minutes, floored to the quarter hour: exactly what the form showed.
          const departure = jerusalemTime(row.depart_at as string);
          expect(departure).toBe(estimatedDeparture.padStart(5, "0"));
          expect(departure < "09:30").toBe(true);
          expect(Number(departure.slice(3)) % 15).toBe(0);
        });

        await test.step("/my says how the time was entered", async () => {
          await page.goto(paths.my());
          const entered = page.locator(`[data-request-id="${requestId}"]`).getByTestId("request-entered-times");
          await expect(entered).toContainText(tv("requestSentence.enteredArriveBy", { time: "09:30" }));
        });
      } finally {
        if (requestId) await deleteRequests(service, [requestId]);
        else await service.from("requests").delete().eq("requester_id", PROFILE_IDS.member2).eq("ride_description", marker);
        await week.cleanup();
      }
    });
  }

  test("?day= preselects the day of the sentence", async ({ page }) => {
    const week = await memberOpenWeek();
    try {
      const thursday = dayOfWeek(week.weekStart, 4);
      await signIn(page, SEEDED_USERS.member2);
      await page.goto(paths.requests.new({ week: week.weekStart, day: thursday }));
      await expect(page.getByTestId("request-overlay")).toBeVisible();
      await expect(page.getByTestId("chip-day")).toContainText(dayMonthLabel(thursday));
    } finally {
      await week.cleanup();
    }
  });
});
