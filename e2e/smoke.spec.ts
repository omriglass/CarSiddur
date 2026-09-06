import { expect, test } from "@playwright/test";

// Minimal smoke test: the shell loads, RTL/Hebrew is wired end to end. The
// four flow specs (submit-request, solve-and-publish, proposal-accept-deeplink,
// cancel-freed-slot) land per ARCHITECTURE.md §14 as features are built.
test("home page loads with Hebrew RTL document", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  await expect(page).toHaveTitle(/סידור רכב נבו/);
});
