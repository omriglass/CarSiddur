import { expect, test } from "@playwright/test";

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
    await page.getByLabel("מחלקה").click();
    await page.getByRole("option", { name: DEPARTMENT_NAME }).click();

    await page.getByRole("button", { name: "הוסף תצורה" }).click();

    await page.getByRole("button", { name: "שמירה", exact: true }).click();

    await expect(page.getByRole("cell", { name: carName })).toBeVisible();
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
