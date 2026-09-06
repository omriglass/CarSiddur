import { expect, test } from "@playwright/test";

// Sadran flows (stage 2b, docs/UX_FLOWS.md §4), on top of the seeded local
// stack (supabase/seed.sql): sadran@nevo.local is the standing Sadran of
// department "נבו", which has an Open week (two freshly submitted requests,
// not yet solved) and a Live week (already published). Runs against the
// local Supabase stack + seed like the other specs (ARCHITECTURE.md §14).
const SADRAN_EMAIL = "sadran@nevo.local";
const SADRAN_PASSWORD = "nevo-demo-1234";

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("אימייל").fill(SADRAN_EMAIL);
  await page.getByLabel("סיסמה").fill(SADRAN_PASSWORD);
  await page.getByRole("button", { name: "התחברות", exact: true }).click();
  await expect(page).toHaveURL(/\/my$/);
}

test.describe("sadran", () => {
  test("opens the open week, runs the solver, applies the draft, and sees rides on the board", async ({ page }) => {
    await signIn(page);

    await page.goto("/sadran");
    await expect(page).toHaveURL(/\/sadran\/[\w-]+\/\d{4}-\d{2}-\d{2}$/);
    await expect(page.getByRole("heading", { name: "סידור השבוע" })).toBeVisible();

    await page.getByRole("button", { name: "הרץ פותר" }).click();
    await expect(page.getByRole("heading", { name: "תוצאת הפתרון" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "החל טיוטה" }).click();

    await expect(page).toHaveURL(/\/board$/);
    await expect(page.getByRole("heading", { name: "לוח הסידור" })).toBeVisible();
  });

  test("creates a shift proposal and sees a wa.me link", async ({ page }) => {
    await signIn(page);
    await page.goto("/sadran");
    await expect(page).toHaveURL(/\/sadran\/[\w-]+\/\d{4}-\d{2}-\d{2}$/);
    const weekUrl = page.url();

    await page.goto(`${weekUrl}/proposals`);
    await expect(page.getByRole("heading", { name: "הצעות" })).toBeVisible();

    // Manual composer entry (request select + type, defaults to "shift").
    await page.getByRole("combobox").first().click();
    await page.getByRole("option").first().click();
    await page.getByRole("button", { name: "הצע", exact: true }).click();

    await expect(page).toHaveURL(/\/proposals\/new$/);
    await page.getByRole("button", { name: "הצע", exact: true }).click();

    const waLink = page.locator('a[href^="https://wa.me/"]').first();
    await expect(waLink).toBeVisible({ timeout: 10_000 });
    await expect(waLink).toHaveAttribute("href", /^https:\/\/wa\.me\/\d+\?text=/);
  });

  test("publishes the week and sees a siddur version", async ({ page }) => {
    // Fixed in Stage 3 hardening (supabase/migrations/20260907092500_fix_publish_siddur_notified_count.sql,
    // DATA_MODEL.md §6.1 item 16, UX_FLOWS.md §16 item 1): `publish_siddur()` now computes
    // `notified_count` before the `siddur_versions` insert instead of updating it after, so
    // the immutability trigger is never exercised. Un-skipped accordingly.
    await signIn(page);
    await page.goto("/sadran");
    await expect(page).toHaveURL(/\/sadran\/[\w-]+\/\d{4}-\d{2}-\d{2}$/);
    const weekUrl = page.url();

    await page.goto(`${weekUrl}/publish`);
    await expect(page.getByRole("heading", { name: "פרסום הסידור" })).toBeVisible();

    await page.getByRole("button", { name: "פרסם ושלח הודעות" }).click();
    await expect(page).toHaveURL(weekUrl);

    await page.goto(`${weekUrl}/publish`);
    await expect(page.getByText("קודמת: גרסה", { exact: false })).toBeVisible();
  });
});
