import { expect, test } from "@playwright/test";
import { he } from "../src/i18n/he";
import { getWeekStart, NEVO_DEPARTMENT_ID, SEEDED_USERS, signIn } from "./helpers";
import { paths } from "../src/app/routes";

// Board mobile header redesign (UX_FLOWS.md §4.2, owner spec 2026-09-10): the title is itself
// the department/week switcher, an "eye" icon collapses display options, a kebab "actions" menu
// replaces the old inline button row, undo/redo are icon buttons, and the policy `<Select>`
// became a tappable chip that opens a versions dialog. There is no standalone "הרץ פותר" button
// any more — solving happens via the kebab's "auto-fill"/"full re-solve" actions.
test.use({ viewport: { width: 390, height: 844 } });

test.describe("board mobile header", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, SEEDED_USERS.sadran);
  });

  test("title switcher opens and switches weeks", async ({ page }) => {
    const openWeekStart = await getWeekStart("open");
    await page.goto(paths.sadran.board(NEVO_DEPARTMENT_ID, openWeekStart));
    const switcher = page.getByTestId("board-title-switcher");
    await expect(switcher).toBeVisible();
    await switcher.click();
    const liveWeekStart = await getWeekStart("live");
    const liveOption = page.getByTestId(`board-week-option-${liveWeekStart}`);
    await expect(liveOption).toBeVisible();
    await liveOption.click();
    await expect(page).toHaveURL(new RegExp(`/${liveWeekStart}/board$`));
  });

  test("eye menu toggles table view", async ({ page }) => {
    const openWeekStart = await getWeekStart("open");
    await page.goto(paths.sadran.board(NEVO_DEPARTMENT_ID, openWeekStart));
    const menuTrigger = page.locator('[data-testid="board-display-menu-trigger"]:visible');
    await menuTrigger.click();
    await page.getByRole("menuitemradio", { name: he.tableView.table, exact: true }).click();
    await expect(page.locator("[data-car-col-id]").first()).toBeVisible();
  });

  test("kebab menu contains export, differences, auto-fill, full re-solve", async ({ page }) => {
    const openWeekStart = await getWeekStart("open");
    await page.goto(paths.sadran.board(NEVO_DEPARTMENT_ID, openWeekStart));
    await page.getByTestId("board-actions-menu-trigger").click();
    await expect(page.getByRole("menuitem", { name: he.excelExport.button, exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: he.deviations.title, exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: he.action.autoSolveRemaining, exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: he.sadranDashboard.fullResolveButton, exact: true })).toBeVisible();
    // No standalone "run solver" button anywhere on the board (owner spec 2026-09-10).
    await expect(page.getByRole("button", { name: "הרץ פותר" })).toHaveCount(0);
  });

  test("undo/redo icons are present, redo disabled initially", async ({ page }) => {
    const openWeekStart = await getWeekStart("open");
    await page.goto(paths.sadran.board(NEVO_DEPARTMENT_ID, openWeekStart));
    const undoButton = page.getByRole("button", { name: he.action.undo, exact: true });
    const redoButton = page.getByRole("button", { name: he.sadranBoard.redo, exact: true });
    await expect(undoButton).toBeVisible();
    await expect(redoButton).toBeVisible();
    await expect(redoButton).toBeDisabled();
  });

  test("policy chip opens the versions dialog showing a version number", async ({ page }) => {
    const openWeekStart = await getWeekStart("open");
    await page.goto(paths.sadran.board(NEVO_DEPARTMENT_ID, openWeekStart));
    const chip = page.getByText(/גרסה \d+/).first();
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByText(/גרסה \d+/).first()).toBeVisible();
  });
});
