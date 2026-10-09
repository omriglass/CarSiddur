import { expect, test } from "@playwright/test";

import { he } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, primeLanding, SEEDED_USERS, serviceRoleClient, signIn } from "./helpers";
import { chooseDestination, fillTimeField, memberOpenWeek, PLACES, setClassicForm } from "./request-form";

// REQ §13.113 / UX_FLOWS §3.4a "Rush hours": the admin edits the windows + percentages in the department settings, and the
// request form's "להגיע עד" estimate stretches only the part of the drive inside a window (Sunday-Thursday). Written by P5
// of the 2026-10 pilot fix round; run by the lead with the full suite.
test.use({ viewport: { width: 390, height: 844 } });

const DEFAULTS = {
  rush_morning_start: "07:00:00", rush_morning_end: "09:30:00", rush_morning_percent: 30,
  rush_afternoon_start: "15:30:00", rush_afternoon_end: "18:30:00", rush_afternoon_percent: 20,
};

test.describe("rush hours", { tag: ["@request-form", "@admin"] }, () => {
  test.afterEach(async () => {
    await serviceRoleClient().from("department_settings").update(DEFAULTS).eq("department_id", NEVO_DEPARTMENT_ID);
    await setClassicForm(SEEDED_USERS.member2.email, true);
  });

  test("the admin edits the morning percentage and an invalid window is refused", async ({ page }) => {
    await primeLanding(page);
    await page.goto("/login");
    await page.getByLabel("אימייל").fill("admin@nevo.local");
    await page.getByLabel("סיסמה").fill("nevo-demo-1234");
    await page.getByRole("button", { name: "התחברות", exact: true }).click();
    await expect(page).toHaveURL(/\/my$/);

    await page.goto("/admin/settings");
    await page.getByRole("button", { name: he.adminCommon.edit, exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    const morning = dialog.getByTestId("rush-morning");
    await expect(morning.getByTestId("rush-morning-percent")).toHaveValue("30");
    await expect(dialog.getByTestId("rush-afternoon").getByTestId("rush-afternoon-percent")).toHaveValue("20");

    await morning.getByTestId("rush-morning-percent").fill("50");
    await dialog.getByRole("button", { name: he.adminCommon.save, exact: true }).click();
    await expect(page.getByText(he.adminCommon.savedToast, { exact: true })).toBeVisible();
    const { data } = await serviceRoleClient().from("department_settings").select("rush_morning_percent").eq("department_id", NEVO_DEPARTMENT_ID).single();
    expect(data?.rush_morning_percent).toBe(50);

    // Out of range: the form refuses (no save, the stored value stays 50).
    await morning.getByTestId("rush-morning-percent").fill("150");
    await dialog.getByRole("button", { name: he.adminCommon.save, exact: true }).click();
    const { data: after } = await serviceRoleClient().from("department_settings").select("rush_morning_percent").eq("department_id", NEVO_DEPARTMENT_ID).single();
    expect(after?.rush_morning_percent).toBe(50);
  });

  test("an arrive-by inside the morning window shows a stretched, estimate-only line; Friday stays plain", async ({ page }) => {
    await setClassicForm(SEEDED_USERS.member2.email, false);
    await memberOpenWeek();
    await signIn(page, SEEDED_USERS.member2);
    await page.goto("/requests/new");
    await expect(page.getByTestId("request-sentence")).toBeVisible();
    await chooseDestination(page, PLACES.haifa.name);

    const arriveBy = async (dayIndex: number) => {
      await page.getByTestId("chip-day").click();
      await page.getByRole("radiogroup", { name: he.field.day }).first().getByRole("radio").nth(dayIndex).click();
      await page.getByRole("button", { name: he.requestSentence.sheetDone, exact: true }).click();
      await page.getByTestId("chip-out").click();
      const sheet = page.getByRole("dialog");
      await sheet.getByRole("radio", { name: he.requestSentence.anchor.outArrive }).click();
      await fillTimeField(sheet, he.field.depart, "09:00");
      const estimate = sheet.getByTestId("time-estimate-out");
      await expect(estimate).toBeVisible();
      const text = await estimate.innerText();
      await page.getByRole("button", { name: he.requestSentence.sheetDone, exact: true }).click();
      return text;
    };

    const sunday = await arriveBy(0);
    expect(sunday).toContain(he.requestSentence.estimateNote);
    expect(sunday).toContain("כ־");
    const friday = await arriveBy(5);
    expect(friday).not.toContain(he.requestSentence.estimateNote);
  });
});
