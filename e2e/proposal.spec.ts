import { expect, test } from "@playwright/test";

import { newSignedInPage, SEEDED_USERS, signIn } from "./helpers";

// Full shift-proposal round trip (UX_FLOWS.md §3.6, §4.3; REQUIREMENTS §7.3, ARCHITECTURE §8):
// Sadran creates+sends a proposal, the member answers via the `/p/<token>` deep link with no
// session (a fresh browser context, simulating the WhatsApp-link case), and the Sadran sees it
// accepted and applies it — request 213 is a dedicated seeded request (supabase/seed.sql,
// DATA_MODEL.md §6.1 item 19) with a free-text destination so the composer's manual-entry
// combobox shows a distinguishable label (every other seeded request uses a preset
// destination_id, whose label all collapse to the same ambiguous id-prefix text).
const PROPOSAL_REQUEST_LABEL = "בדיקת הצעה (בדיקה)";

test.describe("proposal round trip", () => {
  test("sadran sends a shift proposal, member accepts via token with no session, sadran applies it", async ({
    page,
    browser,
  }) => {
    await signIn(page, SEEDED_USERS.sadran);

    await page.goto("/sadran");
    await expect(page).toHaveURL(/\/sadran\/[\w-]+\/\d{4}-\d{2}-\d{2}$/);
    const weekUrl = page.url();

    await page.goto(`${weekUrl}/proposals`);
    await expect(page.getByRole("heading", { name: "הצעות" })).toBeVisible();

    // Manual composer entry, selecting the dedicated seeded request by its distinguishable label.
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: PROPOSAL_REQUEST_LABEL }).click();
    await page.getByRole("button", { name: "הצע", exact: true }).click();

    await expect(page).toHaveURL(/\/proposals\/new$/);
    await expect(page.getByText(PROPOSAL_REQUEST_LABEL).first()).toBeVisible();

    // Create + send (defaults to type "shift"; the request's own depart/return times are used).
    await page.getByRole("button", { name: "הצע", exact: true }).click();

    await page.getByRole("button", { name: /פתח בוואטסאפ/ }).first().click();
    const waLink = page.locator('a[href^="https://wa.me/"]').first();
    await expect(waLink).toBeVisible({ timeout: 10_000 });
    const href = await waLink.getAttribute("href");
    expect(href).toBeTruthy();

    const text = decodeURIComponent(new URL(href as string).searchParams.get("text") ?? "");
    const tokenMatch = text.match(/\/p\/([\w-]+)/);
    expect(tokenMatch, `expected a /p/<token> link inside the wa.me text, got: ${text}`).toBeTruthy();
    const token = (tokenMatch as RegExpMatchArray)[1];

    // Fresh, unauthenticated browser context — no session at all (ARCHITECTURE.md §8: the
    // WhatsApp link must work standalone, since iOS WhatsApp does not share the PWA session).
    const anonContext = await browser.newContext();
    const anonPage = await anonContext.newPage();
    try {
      await anonPage.goto(`/p/${token}`);

      // Before/after summary (ProposalTokenPage.tsx `BeforeAfterBox`s).
      await expect(anonPage.getByText("המקורי")).toBeVisible();
      await expect(anonPage.getByText("המוצע")).toBeVisible();
      await expect(anonPage.getByText("הבקשה שלך")).toBeVisible();

      await anonPage.getByRole("button", { name: "מקבל/ת את ההצעה" }).click();
      await expect(anonPage.getByText("תודה! הסדרן/ית יעדכנו את הסידור")).toBeVisible();
    } finally {
      await anonContext.close();
    }

    // Back as sadran: revisit via the proposals list (not a reload — `proposalId` only
    // survives navigation, not a full page reload, since it's plain component state; the list
    // card carries it in router state, Stage 3 hardening fix, UX_FLOWS.md §16 item 9).
    // `proposal_parties_roll_up()` flips the proposal to 'accepted' the instant the sole
    // party answers.
    await page.goto(`${weekUrl}/proposals`);
    await page.getByText(PROPOSAL_REQUEST_LABEL).first().click();
    await expect(page.getByText("אושרה", { exact: false }).first()).toBeVisible({ timeout: 10_000 });

    // Apply it (Stage 3 hardening fix — see UX_FLOWS.md §16 item 9: `he.sadranProposal.applyNow`
    // existed but no screen ever rendered the button before this pass).
    const applyButton = page.getByRole("button", { name: "החל", exact: true });
    if (await applyButton.count()) {
      await applyButton.click();
      await expect(page.getByText("הוטמע בלוח")).toBeVisible();
    } else {
      // The seeded department's `auto_apply_accepted_proposals` defaults to true (single
      // party) — the proposal may already show 'applied' with no manual button to click.
      await expect(page.getByText("יושמה אוטומטית", { exact: false })).toBeVisible();
    }

    // As the member: the request now shows the proposal's outcome in "My requests" — a
    // separate browser context (Stage 3 hardening fix, e2e/helpers.ts `newSignedInPage`:
    // reusing `page` for a second identity is unreliable, since `/login` redirects an
    // already-authenticated session straight back to wherever it came from, never showing the
    // sign-in form again).
    //
    // Manually-composed proposals from the dropdown (`ProposalsListScreen.tsx`) never carry a
    // `car_id` in their payload (only the board's suggestion/drag actions know a car), so
    // `apply_proposal()`'s `shift` branch takes its documented no-car-id path
    // (DATA_MODEL.md §6.1 item 6): it updates the window and returns the request to
    // `submitted`/`PROPOSAL_APPLIED_PENDING_ASSIGNMENT` for the Sadran to place on the board
    // next, rather than `assigned` — this is the correct, already-documented outcome, not a
    // bug, so the request stays `submitted` here with that status reason.
    const member1 = await newSignedInPage(browser, SEEDED_USERS.member1);
    try {
      await member1.page.goto("/requests");
      const requestCard = member1.page.locator("div.rounded-md", { hasText: PROPOSAL_REQUEST_LABEL });
      await expect(requestCard.getByText("ההצעה אושרה, ממתין לשיבוץ רכב")).toBeVisible({ timeout: 10_000 });
    } finally {
      await member1.context.close();
    }
  });
});
