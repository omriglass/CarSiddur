import { expect, test } from "@playwright/test";

import { getWeekStart, SEEDED_USERS, signIn } from "./helpers";

// REQUIREMENTS §8 "New request on a free car": in a Live week, a round-trip request at a
// time when a shared car is free and at home auto-approves immediately (`try_auto_approve()`,
// no Sadran action) and both the member and the Sadran are notified. Exercised through the
// real UI: `/requests/new` previously had no way to target the Live week at all once an Open
// week also existed (Stage 3 hardening fix, UX_FLOWS.md §16 item 7) — `?week=` now overrides
// the page's smart-default week resolution.
const DESTINATION = "בדיקת אישור אוטומטי";

test.describe("auto-approve on a free car (live week)", () => {
  test("member2 submits a new request and it is assigned immediately, with an inbox notification", async ({
    page,
  }) => {
    const liveWeekStart = await getWeekStart("live");

    await signIn(page, SEEDED_USERS.member2);

    await page.goto(`/requests/new?week=${liveWeekStart}`);
    await expect(page.getByText("בקשה חדשה")).toBeVisible();

    await page.getByRole("combobox").first().click();
    await page.getByPlaceholder("לאן?").fill(DESTINATION);
    await page.getByText(`"${DESTINATION}" — יעד חופשי`).click();

    await page.getByRole("radiogroup", { name: "סוג נסיעה" }).getByRole("radio").first().click();

    // Thursday of the target week — free of every seeded ride in the Live week (only
    // Tuesday/Wednesday have any), so any of the three shared cars is free at the form's
    // default 08:00–12:00 window regardless of what other specs already did to this week.
    await page.getByRole("radiogroup", { name: "יום" }).getByRole("radio").nth(4).click();

    await page.getByRole("button", { name: "שלח/י בקשה" }).click();

    await expect(page).toHaveURL(/\/requests$/);
    const requestCard = page.locator("div.rounded-md", { hasText: DESTINATION });
    await expect(requestCard.getByText("שובצה")).toBeVisible({ timeout: 10_000 });

    await page.goto("/inbox");
    await expect(page.getByText("הבקשה אושרה אוטומטית")).toBeVisible({ timeout: 10_000 });
  });
});
