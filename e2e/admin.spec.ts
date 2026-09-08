import { expect, test } from "@playwright/test";

import { he } from "../src/i18n/he";
import { SEEDED_USERS, signIn } from "./helpers";

// Admin screens smoke test (stage 2c, docs/UX_FLOWS.md §5): the seeded demo
// admin (supabase/seed.sql) creates a car with a seat config, a destination
// and a policy version, and each shows up where expected. Runs against the
// local Supabase stack + seed like the other specs (ARCHITECTURE.md §14).
const ADMIN_EMAIL = "admin@nevo.local";
const ADMIN_PASSWORD = "nevo-demo-1234";
const DEPARTMENT_NAME = "נבו"; // supabase/seed.sql

test.describe("admin", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("אימייל").fill(ADMIN_EMAIL);
    await page.getByLabel("סיסמה").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "התחברות", exact: true }).click();
    await expect(page).toHaveURL(/\/my$/);
  });

  test("edits member details and assigns an ordinary member without permanent promotion", async ({ page }) => {
    await page.goto("/admin/members");
    const row = page.getByRole("row").filter({ hasText: "member2@nevo.local" });
    const nameButton = row.getByRole("button").first();
    const originalName = await nameButton.innerText();
    await nameButton.click();
    const editor = page.getByRole("dialog");
    const originalPhone = await editor.getByLabel(he.adminMembers.columnPhone).inputValue();
    const editedName = `Member edit ${Date.now()}`;
    await editor.getByLabel(he.adminMembers.columnName).fill(editedName);
    await editor.getByLabel(he.adminMembers.columnPhone).fill("+972509998877");
    await editor.getByRole("button", { name: he.adminCommon.save, exact: true }).click();
    await expect(editor).not.toBeVisible();
    await expect(row).toContainText(editedName);
    await expect(row).toContainText("+972509998877");
    await row.getByRole("combobox").click();
    await page.getByRole("option", { name: he.adminMembers.roleMember, exact: true }).click();
    await expect(row.getByRole("combobox")).toContainText(he.adminMembers.roleMember);

    await page.goto("/admin/roster");
    // A distant week avoids changing the current live fixture's coordinator.
    const cell = page.locator("tbody tr").last().locator("td").nth(1);
    await cell.click();
    await page.getByRole("dialog").getByRole("checkbox", { name: editedName, exact: true }).check();
    await page.getByRole("dialog").getByRole("button", { name: he.adminCommon.save, exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(cell).toContainText(editedName);
    await page.goto("/admin/members");
    await expect(row.getByRole("combobox")).toContainText(he.adminMembers.roleMember);
    await row.getByRole("button", { name: editedName, exact: true }).click();
    await editor.getByLabel(he.adminMembers.columnName).fill(originalName);
    await editor.getByLabel(he.adminMembers.columnPhone).fill(originalPhone);
    await editor.getByRole("button", { name: he.adminCommon.save, exact: true }).click();
    await expect(editor).not.toBeVisible();
  });

  test("admin home lists every management area", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "ניהול מערכת" })).toBeVisible();
    await expect(page.locator('a[href="/admin/cars"]')).toBeVisible();
    await expect(page.locator('a[href="/admin/destinations"]')).toBeVisible();
    await expect(page.locator('a[href="/admin/policies"]')).toBeVisible();
  });

  test("creates a car with a seat config and sees it in the list", async ({ page }) => {
    const unique = Date.now();
    const carName = `רכב בדיקה ${unique}`;
    const plate = `${unique}`.slice(-7);

    await page.goto("/admin/cars");
    await page.getByRole("button", { name: "רכב חדש" }).click();

    await page.getByLabel("שם הרכב").fill(carName);
    await page.getByLabel("מספר רישוי").fill(plate);
    await page.getByLabel(he.adminCars.fieldAccessCode, { exact: true }).fill("01234");
    await page.getByLabel("מחלקה").click();
    await page.getByRole("option", { name: DEPARTMENT_NAME }).click();

    await page.getByRole("button", { name: "הוסף תצורה" }).click();

    await page.getByRole("button", { name: "שמירה", exact: true }).click();

    await expect(page.getByRole("cell", { name: carName })).toBeVisible();

    // Codes remain text across editing, and ending a replacement clears its old code.
    await page.getByRole("cell", { name: carName, exact: true }).click();
    await expect(page.getByLabel(he.adminCars.fieldAccessCode, { exact: true })).toHaveValue("01234");
    await page.getByRole("checkbox", { name: he.adminCars.fieldIsReplaced }).check();
    await page.getByLabel(he.adminCars.fieldReplacementCode, { exact: true }).fill("0567");
    await page.getByRole("button", { name: he.adminCommon.save, exact: true }).click();
    const carRow = page.getByRole("row").filter({ hasText: carName });
    await expect(carRow.getByText(he.adminCars.replacedBadge, { exact: true })).toBeVisible();
    await carRow.click();
    await expect(page.getByLabel(he.adminCars.fieldReplacementCode, { exact: true })).toHaveValue("0567");
    await page.getByRole("checkbox", { name: he.adminCars.fieldIsReplaced }).uncheck();
    await page.getByRole("button", { name: he.adminCommon.save, exact: true }).click();
    await carRow.click();
    await page.getByRole("checkbox", { name: he.adminCars.fieldIsReplaced }).check();
    await expect(page.getByLabel(he.adminCars.fieldReplacementCode, { exact: true })).toHaveValue("");
  });

  test("creates a destination and sees it in the list", async ({ page }) => {
    const unique = Date.now();
    const destinationName = `יעד בדיקה ${unique}`;

    await page.goto("/admin/destinations");
    await page.getByRole("button", { name: "יעד חדש" }).click();

    await page.getByLabel("שם היעד").fill(destinationName);
    await page.getByRole("button", { name: "שמירה", exact: true }).click();

    await expect(page.getByRole("cell", { name: destinationName })).toBeVisible();
  });

  test("creates a policy version and sees it in the history tab", async ({ page }) => {
    const unique = Date.now();
    const policyName = `מדיניות בדיקה ${unique}`;

    await page.goto("/admin/policies");
    await page.getByRole("button", { name: "מדיניות חדשה" }).click();

    // The dialog's own "name" field (he.adminCommon.name) inside the "new policy" dialog.
    await page.getByRole("dialog").getByLabel("שם").fill(policyName);
    await page.getByRole("dialog").getByRole("button", { name: "שמירה" }).click();

    await expect(page).toHaveURL(/\/admin\/policies\/[\w-]+$/);
    await expect(page.getByRole("heading", { name: policyName })).toBeVisible();

    // Enable the first rule row and save as version 1.
    await page.getByRole("checkbox").first().check();
    await page.getByRole("textbox").last().fill("בדיקת e2e");
    await page.getByRole("button", { name: /שמור כגרסה/ }).click();

    await expect(page.getByText("נשמר")).toBeVisible();

    await page.getByRole("tab", { name: "היסטוריית גרסאות" }).click();
    await expect(page.getByRole("cell", { name: "1", exact: true })).toBeVisible();
  });
});


test.describe("Sadran operational administration", () => {
  test.beforeEach(async ({ page }) => { await signIn(page, SEEDED_USERS.sadran); });

  test("can manage operational areas while department, member and roster routes stay protected", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("link", { name: he.nav.admin, exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    for (const area of ["cars", "destinations", "ride-types", "policies", "templates", "settings"]) {
      await expect(page.locator(`a[href="/admin/${area}"]`)).toBeVisible();
    }
    for (const area of ["departments", "members", "roster"]) {
      await expect(page.locator(`a[href="/admin/${area}"]`)).toHaveCount(0);
      await page.goto(`/admin/${area}`);
      await expect(page).toHaveURL(/\/my$/);
    }
  });

  test("creates a destination and edits operational settings without department fields", async ({ page }) => {
    const destinationName = `Sadran E2E destination ${Date.now()}`;
    await page.goto("/admin/destinations");
    await page.getByRole("button", { name: he.adminDestinations.new }).click();
    await page.getByLabel(he.adminDestinations.fieldName).fill(destinationName);
    await page.getByRole("button", { name: he.adminCommon.save, exact: true }).click();
    await expect(page.getByRole("cell", { name: destinationName })).toBeVisible();

    await page.goto("/admin/settings");
    await page.getByRole("button", { name: he.adminCommon.edit, exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(he.adminDepartments.sectionSettings)).toBeVisible();
    await expect(dialog.getByLabel(he.adminDepartments.fieldSlug)).toHaveCount(0);
    await expect(dialog.getByLabel(he.adminDepartments.fieldTurnaround)).toHaveValue("30");
    await dialog.getByRole("button", { name: he.adminCommon.save, exact: true }).click();
    await expect(page.getByText(he.adminCommon.savedToast, { exact: true })).toBeVisible();
  });
});
