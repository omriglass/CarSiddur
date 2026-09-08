import { expect, test } from "@playwright/test";
import { t } from "../src/i18n/he";
import { SEEDED_USERS, signIn } from "./helpers";

test("home suggests device setup and remembers dismissal across refresh", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, SEEDED_USERS.member1);
  const install = page.getByTestId("install-suggestion");
  await expect(install).toBeVisible();
  await expect(page.getByTestId("notification-suggestion")).toBeVisible();
  await install.getByRole("button", { name: t("deviceSetup.later") }).click();
  await page.reload();
  await expect(page.getByTestId("notification-suggestion")).toBeVisible();
  await expect(install).toHaveCount(0);
});

test("iOS browser suggests home-screen installation before notifications", async ({ browser }) => {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await signIn(page, SEEDED_USERS.member1);
  await expect(page.getByText(t("installHint.ios"))).toBeVisible();
  await expect(page.getByTestId("notification-suggestion")).toHaveCount(0);
  await context.close();
});
