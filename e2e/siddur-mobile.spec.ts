import { expect, test } from "@playwright/test";
import { he } from "../src/i18n/he";
import { getWeekStart, NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, signIn } from "./helpers";
import { paths } from "../src/app/routes";

// Mobile siddur header redesign (UX_FLOWS.md member siddur "mobile header", 2026-09-10): the
// title is itself the this/next week switcher, a single "eye" icon collapses table view + early
// hours into one menu, a car-now/waitlist row replaces the old always-visible buttons, and past
// weeks moved to a dedicated archive screen. Runs at a phone viewport since these controls are
// mobile-only (`md:hidden`).
test.use({ viewport: { width: 390, height: 844 } });

test.describe("siddur mobile header", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SEEDED_USERS.member1);
  });

  test("title switcher opens and switches between this week and next week", async ({ page }) => {
    const liveWeekStart = await getWeekStart("live");
    await page.goto(paths.siddur({ dept: NEVO_DEPARTMENT_ID, week: liveWeekStart }));
    const switcher = page.getByTestId("siddur-week-switcher");
    await expect(switcher).toContainText(he.siddur.thisWeek);
    await switcher.click();
    await expect(page.getByTestId("siddur-week-option-this")).toBeVisible();
    await expect(page.getByTestId("siddur-week-option-next")).toBeVisible();
    await expect(page.getByTestId("siddur-week-option-archive")).toBeVisible();
    await page.getByTestId("siddur-week-option-next").click();
    await expect(page).not.toHaveURL(new RegExp(`/${liveWeekStart}$`));
    await expect(page.getByTestId("siddur-week-switcher")).toContainText(he.siddur.nextWeek);
  });

  test("eye menu toggles table view and early hours, persisting across reload", async ({ page }) => {
    const liveWeekStart = await getWeekStart("live");
    await page.goto(paths.siddur({ dept: NEVO_DEPARTMENT_ID, week: liveWeekStart }));
    // Both the mobile (`md:hidden`) and desktop (`hidden md:flex`) headers render their own
    // `SiddurDisplayMenu` instance simultaneously (CSS-hidden, not unmounted) — scope to the
    // one actually visible at this viewport.
    const menuTrigger = page.locator('[data-testid="siddur-display-menu-trigger"]:visible');
    // `WeekGrid` (table view) is a CSS grid of divs, not a semantic `<table>` — its car
    // columns (`[data-car-col-id]`) are the reliable signal that table view replaced the
    // phone day-list.
    const gridColumn = page.locator("[data-car-col-id]").first();
    await menuTrigger.click();
    await page.getByRole("menuitemradio", { name: he.tableView.table, exact: true }).click();
    await expect(gridColumn).toBeVisible();
    // Switching to table view re-renders `WeekGrid` with real data — let that settle before
    // opening the menu again, or the dropdown's own position/content re-measures mid-click.
    await page.waitForTimeout(500);

    await menuTrigger.click();
    const earlyHoursItem = page.getByRole("menuitemcheckbox", { name: he.board.showEarlyHours, exact: true });
    await expect(earlyHoursItem).toBeVisible();
    await earlyHoursItem.click();
    await page.keyboard.press("Escape");

    await page.reload();
    await expect(gridColumn).toBeVisible();
    await menuTrigger.click();
    await expect(page.getByRole("menuitemcheckbox", { name: he.board.hideEarlyHours, exact: true })).toBeVisible();
  });

  test("car-now button reflects whether a shared car is free right now", async ({ page }) => {
    const liveWeekStart = await getWeekStart("live");
    const service = serviceRoleClient();
    const { data: department } = await service.from("departments").select("home_destination_id").eq("id", NEVO_DEPARTMENT_ID).single();
    const { data: sharedCars } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active");
    const carIds = (sharedCars ?? []).map((c) => c.id);
    expect(carIds.length).toBeGreaterThan(0);
    const now = new Date();
    // `rides.starts_at`/`ends_at` must land on a quarter-hour (`rides_ends_qh_ck`).
    const roundToQuarterHour = (ms: number) => Math.round(ms / 900_000) * 900_000;
    const blockStart = new Date(roundToQuarterHour(now.getTime() - 2 * 3600_000)).toISOString();
    const blockEnd = new Date(roundToQuarterHour(now.getTime() + 2 * 3600_000)).toISOString();
    const inserted = await service.from("rides").insert(carIds.map((carId) => ({
      department_id: NEVO_DEPARTMENT_ID, week_start: liveWeekStart, car_id: carId,
      driver_id: "00000000-0000-0000-0000-000000000102", created_by: "00000000-0000-0000-0000-000000000102",
      origin_id: department!.home_destination_id, destination_id: department!.home_destination_id,
      starts_at: blockStart, ends_at: blockEnd, blocked_until: blockEnd, status: "confirmed",
    }))).select("id");
    if (inserted.error) throw inserted.error;
    try {
      await page.goto(paths.siddur({ dept: NEVO_DEPARTMENT_ID, week: liveWeekStart }));
      const carNowButton = page.getByText(he.quickRequest.noCarNow, { exact: true });
      await expect(carNowButton).toBeVisible();
      await expect(page.locator('[aria-disabled="true"]').filter({ hasText: he.quickRequest.noCarNow })).toBeVisible();

      await service.from("rides").delete().in("id", inserted.data!.map((r) => r.id));
      await page.reload();
      await expect(page.getByText(he.quickRequest.takeCarNow, { exact: true })).toBeVisible();
    } finally {
      await service.from("rides").delete().in("id", inserted.data!.map((r) => r.id));
    }
  });

  test("waitlist button label includes the selected day's letter", async ({ page }) => {
    const liveWeekStart = await getWeekStart("live");
    await page.goto(paths.siddur({ dept: NEVO_DEPARTMENT_ID, week: liveWeekStart }));
    const waitlistButton = page.getByRole("button", { name: /רשימת המתנה ליום/ });
    await expect(waitlistButton).toBeVisible();
  });

  test("archive lists a past week and opens it read-only", async ({ page }) => {
    const service = serviceRoleClient();
    const pastWeekStart = "2020-01-05";
    await service.from("weeks").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", pastWeekStart);
    const { error } = await service.from("weeks").insert({
      department_id: NEVO_DEPARTMENT_ID, week_start: pastWeekStart, phase: "archived",
      open_at: "2020-01-01T00:00:00Z", close_at: "2020-01-03T00:00:00Z", publish_at: "2020-01-04T00:00:00Z",
      published_at: "2020-01-04T00:00:00Z",
    });
    if (error) throw error;
    try {
      await page.goto(paths.siddurArchive(NEVO_DEPARTMENT_ID));
      await expect(page.getByRole("heading", { name: he.siddur.archiveTitle })).toBeVisible();
      const row = page.getByTestId("siddur-archive-row").filter({ hasText: "5.1" });
      await expect(row).toBeVisible();
      await row.click();
      await expect(page.getByText(he.siddur.archivedWeekHint)).toBeVisible();
    } finally {
      await service.from("weeks").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", pastWeekStart);
    }
  });

  test("export button downloads a workbook from the archive", async ({ page }) => {
    const service = serviceRoleClient();
    const pastWeekStart = "2020-02-02";
    await service.from("weeks").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", pastWeekStart);
    const { error } = await service.from("weeks").insert({
      department_id: NEVO_DEPARTMENT_ID, week_start: pastWeekStart, phase: "archived",
      open_at: "2020-01-29T00:00:00Z", close_at: "2020-01-31T00:00:00Z", publish_at: "2020-02-01T00:00:00Z",
      published_at: "2020-02-01T00:00:00Z",
    });
    if (error) throw error;
    try {
      await page.goto(paths.siddurArchive(NEVO_DEPARTMENT_ID));
      const row = page.getByTestId("siddur-archive-row").filter({ hasText: "2.2" });
      await expect(row).toBeVisible();
      const downloadPromise = page.waitForEvent("download");
      await page.getByTestId("siddur-archive-export").click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toMatch(/^siddur-.*\.xlsx$/);
    } finally {
      await service.from("weeks").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", pastWeekStart);
    }
  });
});
