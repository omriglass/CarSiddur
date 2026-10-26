import { expect, type Page, test } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he, t } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient, signIn } from "./helpers";

// REQ §13.154 "planning ahead" (תכנון קדימה): a member files a draft request ("טיוטת בקשה") for a day weeks ahead from
// the month view; everyone sees it read-only; the owner cancels it from the day sheet; when its week opens it shows on
// /my as a suggestion ("use" / "not needed"); the helper always marks at least one best day.
const DESTINATION = "E2E planning destination";
const MEMBER_ID = "00000000-0000-0000-0000-000000000103";

test.use({ viewport: { width: 390, height: 844 } });

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** A Tuesday 6–7 weeks ahead: inside the 3-month window, its week not open yet. */
function plannableTuesday(): string {
  const today = new Date().toISOString().slice(0, 10);
  let day = addDays(today, 42);
  while (new Date(`${day}T12:00:00Z`).getUTCDay() !== 2) day = addDays(day, 1);
  return day;
}

const weekStartOf = (day: string) => addDays(day, -new Date(`${day}T12:00:00Z`).getUTCDay());

async function cleanup() {
  const service = serviceRoleClient();
  const { data } = await service.from("request_templates").select("id").eq("requester_id", MEMBER_ID).eq("destination_text", DESTINATION);
  const ids = (data ?? []).map((row) => row.id as string);
  if (ids.length) {
    await service.from("requests").update({ template_id: null }).in("template_id", ids);
    await service.from("request_templates").delete().in("id", ids);
  }
  await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("destination_text", DESTINATION);
}

/** Opens the month view and pages forward until `day`'s cell is on screen. */
async function openMonthAt(page: Page, day: string) {
  await page.goto(paths.plan(NEVO_DEPARTMENT_ID));
  await expect(page.getByTestId("planning-month-title")).toBeVisible();
  const cell = page.getByTestId(`planning-cell-${day}`);
  for (let i = 0; i < 4 && !(await cell.isVisible()); i += 1) {
    await page.getByRole("button", { name: he.planning.nextMonth, exact: true }).click();
  }
  await expect(cell).toBeVisible();
  return cell;
}

/** Files a draft request for `day` through the day sheet and the request form (classic layout, the suite default). */
async function fileDraft(page: Page, day: string) {
  const cell = await openMonthAt(page, day);
  await cell.click();
  await page.getByTestId("planning-reserve").click();
  await expect(page).toHaveURL(new RegExp(`/plan/${NEVO_DEPARTMENT_ID}/new\\?day=${day}`));
  await expect(page.getByTestId("reservation-intro")).toBeVisible();
  await page.getByRole("combobox").filter({ hasText: "לאן?" }).click();
  await page.getByPlaceholder("לאן?").fill(DESTINATION);
  await page.getByText(`"${DESTINATION}" — יעד חופשי`).click();
  await page.getByRole("radiogroup", { name: "סוג נסיעה" }).getByRole("radio").first().click();
  await page.getByRole("button", { name: he.planning.saveButton, exact: true }).click();
  await expect(page.getByText(he.planning.saved)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/plan/${NEVO_DEPARTMENT_ID}$`));
  const { data, error } = await serviceRoleClient().from("request_templates").select("id, schedule, planned_date, cancelled_at")
    .eq("requester_id", MEMBER_ID).eq("destination_text", DESTINATION).is("cancelled_at", null).single();
  if (error) throw error;
  expect(data.schedule).toBe("dated");
  expect(data.planned_date).toBe(day);
  return data.id as string;
}

test.describe("planning ahead", { tag: ["@planning", "@request-form"] }, () => {
  test.beforeEach(cleanup);
  test.afterEach(cleanup);

  test("a member files a draft request from the month view; others see it read-only; the owner cancels it", async ({ page, browser }) => {
    const day = plannableTuesday();
    await signIn(page, SEEDED_USERS.member1);
    // The "big picture" menu beside the eye leads to the month view.
    await page.goto(paths.my());
    await page.getByTestId("long-range-menu-trigger").locator("visible=true").first().click();
    await page.getByTestId("long-range-planning").click();
    await expect(page).toHaveURL(new RegExp(`/plan/${NEVO_DEPARTMENT_ID}$`));

    const id = await fileDraft(page, day);
    // Saving returns to the month view on the current month; page forward to the day again.
    const cell = await openMonthAt(page, day);
    await expect(cell.getByTestId("planning-cell-count")).toBeVisible();

    // Another member sees it in the day sheet with the details, but cannot edit or cancel it.
    const { context, page: other } = await newSignedInPage(browser, SEEDED_USERS.member2);
    try {
      await other.setViewportSize({ width: 390, height: 844 });
      const otherCell = await openMonthAt(other, day);
      await otherCell.click();
      const list = other.getByTestId("planning-day-list");
      await expect(list).toContainText(SEEDED_USERS.member1.fullName);
      await list.getByRole("button").filter({ hasText: SEEDED_USERS.member1.fullName }).first().click();
      await expect(other.getByTestId("planning-reservation-details")).toBeVisible();
      await expect(other.getByTestId("planning-edit")).toHaveCount(0);
      await expect(other.getByTestId("planning-cancel")).toHaveCount(0);
    } finally {
      await context.close();
    }

    // The owner opens it ("שלי"), and cancels it from the sheet.
    await cell.click();
    const mine = page.getByTestId("planning-day-list").getByRole("button").filter({ hasText: he.planning.mine }).first();
    await mine.click();
    await expect(page.getByTestId("planning-edit")).toBeVisible();
    await page.getByTestId("planning-cancel").click();
    await page.getByRole("alertdialog").or(page.getByRole("dialog")).getByRole("button", { name: he.planning.cancel, exact: true }).last().click();
    await expect(page.getByText(he.planning.cancelled)).toBeVisible();
    const { data } = await serviceRoleClient().from("request_templates").select("cancelled_at").eq("id", id).single();
    expect(data?.cancelled_at).toBeTruthy();
  });

  test("when its week opens, the draft request is suggested on /my; 'not needed' cancels it", async ({ page }) => {
    const day = plannableTuesday();
    const week = weekStartOf(day);
    const service = serviceRoleClient();
    await signIn(page, SEEDED_USERS.member1);
    const id = await fileDraft(page, day);

    const { data: existing } = await service.from("weeks").select("phase").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week).maybeSingle();
    if (existing) {
      await service.from("weeks").update({ phase: "open" }).eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    } else {
      const { error } = await service.from("weeks").insert({
        department_id: NEVO_DEPARTMENT_ID, week_start: week, phase: "open",
        open_at: new Date(Date.now() - 86_400_000).toISOString(), close_at: `${addDays(week, -3)}T12:00:00Z`, publish_at: `${addDays(week, -2)}T12:00:00Z`,
      });
      if (error) throw error;
    }
    try {
      await page.goto(`${paths.my()}?view=list`);
      const suggestions = page.getByTestId("template-suggestions");
      await expect(suggestions.getByTestId("reservation-suggestion").first()).toBeVisible();
      await expect(suggestions).toContainText(DESTINATION);
      await expect(suggestions.getByRole("link", { name: t("request.useSuggestion"), exact: true }).first()).toBeVisible();
      await suggestions.getByTestId("reservation-not-needed").first().click();
      await expect(page.getByText(he.planning.cancelled)).toBeVisible();
      const { data } = await service.from("request_templates").select("cancelled_at").eq("id", id).single();
      expect(data?.cancelled_at).toBeTruthy();
    } finally {
      if (existing) await service.from("weeks").update({ phase: existing.phase }).eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
      else {
        // Opening the week sent notices that reference it; drop them so the week row can go (and later specs do not
        // find an extra open week).
        await service.from("notifications").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
        const { error } = await service.from("weeks").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
        expect(error, "the opened week could not be removed").toBeNull();
      }
    }
  });

  test("the helper always marks at least one best day", async ({ page }) => {
    await signIn(page, SEEDED_USERS.member1);
    await page.goto(paths.plan(NEVO_DEPARTMENT_ID));
    await expect(page.getByTestId("planning-helper")).toBeVisible();
    await page.getByTestId("planning-day-2").click();
    await page.getByTestId("planning-pick-f").click();
    let starred = 0;
    for (let i = 0; i < 4 && starred === 0; i += 1) {
      starred = await page.locator('[data-tier="1"], [data-tier="2"], [data-tier="3"]').count();
      if (starred === 0) await page.getByRole("button", { name: he.planning.nextMonth, exact: true }).click();
    }
    expect(starred).toBeGreaterThan(0);
  });
});
