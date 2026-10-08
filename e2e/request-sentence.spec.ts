import { expect, test } from "@playwright/test";

import { he, tv } from "../src/i18n/he";
import { SEEDED_USERS, serviceRoleClient, signIn, submitRequestForm } from "./helpers";

// REQ §13.110 / UX_FLOWS §3.4a: the sentence layout of the request form. The seeded accounts use the
// classic form (e2e/global-setup.ts), so this spec flips one member to the sentence layout for its run
// and restores it afterwards (workers: 1, so no other spec sees the flip).
test.use({ viewport: { width: 390, height: 844 } });

async function setClassic(email: string, classic: boolean) {
  const { error } = await serviceRoleClient().from("profiles").update({ classic_request_form: classic }).eq("email", email);
  if (error) throw error;
}

test.describe("request sentence layout", { tag: ["@request-form"] }, () => {
  test.beforeEach(async () => { await setClassic(SEEDED_USERS.member2.email, false); });
  test.afterEach(async () => { await setClassic(SEEDED_USERS.member2.email, true); });

  test("files an arrive-by request and /my shows how it was entered", async ({ page }) => {
    await signIn(page, SEEDED_USERS.member2);
    await page.goto("/requests/new");
    await expect(page.getByTestId("request-overlay")).toBeVisible();

    const sentence = page.getByTestId("request-sentence");
    await expect(sentence).toBeVisible();

    // Destination chip -> sheet: free text is always offered by the combobox.
    await sentence.getByTestId("chip-destination").click();
    await page.getByPlaceholder(he.requestSentence.placeSearch).fill("עפולה");
    await page.getByText(tv("requestSentence.placeFreeText", { text: "עפולה" })).click();
    await expect(sentence.getByTestId("chip-destination")).toContainText("עפולה");

    // Outbound time: "להגיע עד 09:30" with a derived departure line.
    await sentence.getByTestId("chip-out").click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("radio", { name: he.requestSentence.anchor.outArrive }).click();
    const timeInput = sheet.getByLabel(he.field.depart);
    await timeInput.fill("09:30");
    await timeInput.blur();
    await expect(sheet.getByTestId("time-estimate-out")).toBeVisible();
    await sheet.getByRole("button", { name: he.requestSentence.sheetDone }).click();
    await expect(sentence.getByTestId("chip-out")).toContainText(he.requestSentence.anchor.outArrive);

    await submitRequestForm(page);
    await expect(page).toHaveURL(/\/my$/);
    await expect(page.getByTestId("request-entered-times").filter({ hasText: tv("requestSentence.enteredArriveBy", { time: "09:30" }) }).first()).toBeVisible();
  });

  test("the who chip starts the sentence; stage 2 holds the modifiers and the recap goes back", async ({ page }) => {
    await signIn(page, SEEDED_USERS.member2);
    await page.goto("/requests/new");
    const sentence = page.getByTestId("request-sentence");
    await expect(sentence.getByTestId("chip-who")).toHaveText(he.requestSentence.me);

    // Stage 1 has no submit; "המשך" without a destination reopens the destination sheet.
    await expect(page.getByRole("button", { name: he.action.submitRequest })).toHaveCount(0);
    await page.getByTestId("stage-next").click();
    await expect(page.getByPlaceholder(he.requestSentence.placeSearch)).toBeVisible();
    await page.getByPlaceholder(he.requestSentence.placeSearch).fill("עפולה");
    await page.getByText(tv("requestSentence.placeFreeText", { text: "עפולה" })).click();

    // Who sheet: a guest joins, the verb turns plural.
    await sentence.getByTestId("chip-who").click();
    await page.getByTestId("who-add-guest").click();
    await page.getByLabel(he.requestSentence.whoGuestPlaceholder).fill("נועה");
    await page.getByRole("button", { name: he.requestSentence.whoGuestAdd }).click();
    await page.getByRole("button", { name: he.requestSentence.sheetDone }).click();
    await expect(sentence.getByTestId("chip-who")).toContainText("נועה");
    await expect(sentence).toContainText(he.requestSentence.needsPlural);

    await page.getByTestId("stage-next").click();
    await expect(page.getByTestId("stage-two")).toBeVisible();
    await page.getByTestId("car-choice-luggage").click();
    await page.getByTestId("stage-recap").click();
    await expect(sentence).toBeVisible();
    await submitRequestForm(page);
    await expect(page).toHaveURL(/\/my$/);
  });

  test("the profile switch brings the classic form back", async ({ page }) => {
    await signIn(page, SEEDED_USERS.member2);
    await page.goto("/requests/new");
    await expect(page.getByTestId("request-sentence")).toBeVisible();

    await page.goto("/profile");
    await page.getByLabel(he.profileExtra.classicRequestFormLabel).click();
    await expect(page.getByLabel(he.profileExtra.classicRequestFormLabel)).toBeChecked();

    await page.goto("/requests/new");
    await expect(page.getByTestId("request-sentence")).toHaveCount(0);
    await expect(page.getByRole("combobox").filter({ hasText: he.field.destination })).toBeVisible();
  });
});
