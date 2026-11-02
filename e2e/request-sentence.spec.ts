import { expect, test } from "@playwright/test";

import { he, tv } from "../src/i18n/he";
import { SEEDED_USERS, serviceRoleClient, signIn, submitRequestForm } from "./helpers";
import { dismissGuide } from "./request-form";

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
    await dismissGuide(page);
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

  test("a הקפצה is 'רק הקפצה' / 'רק איסוף' / 'הקפצה ואיסוף'; a pickup swaps the places and files from there home (REQ §13.181)", async ({ page }) => {
    const service = serviceRoleClient();
    const { data: me } = await service.from("profiles").select("id").eq("email", SEEDED_USERS.member2.email).single();
    const startedAt = new Date().toISOString();
    try {
      await signIn(page, SEEDED_USERS.member2);
      await page.goto("/requests/new");
      await dismissGuide(page);
      const sentence = page.getByTestId("request-sentence");
      await sentence.getByTestId("chip-destination").click();
      await page.getByPlaceholder(he.requestSentence.placeSearch).fill("בנימינה עצמאי");
      await page.getByText(tv("requestSentence.placeFreeText", { text: "בנימינה עצמאי" })).click();
      const home = (await sentence.getByTestId("chip-origin").textContent())?.trim() ?? "";

      // the ⇄ swaps the two places, and back
      await sentence.getByTestId("swap-places").click();
      await expect(sentence.getByTestId("chip-origin")).toContainText("בנימינה עצמאי");
      await sentence.getByTestId("swap-places").click();
      await expect(sentence.getByTestId("chip-destination")).toContainText("בנימינה עצמאי");

      // switching a round trip to הקפצה asks in one dialog: "רק איסוף" from a place, at a time
      await sentence.getByTestId("chip-trip").click();
      await page.getByRole("radio", { name: he.request.tripTypeDropOff, exact: true }).click();
      const ask = page.getByTestId("drop-off-switch-dialog");
      await ask.getByTestId("drop-off-switch-mode-pickup").click();
      await ask.getByTestId("drop-off-switch-place").click();
      await page.getByTestId("drop-off-switch-picker").getByRole("textbox").fill("בנימינה עצמאי");
      await page.getByTestId("drop-off-switch-picker").getByText("בנימינה עצמאי").first().click();
      await page.getByRole("button", { name: he.planB.switch.confirm }).click();
      await page.getByRole("button", { name: he.requestSentence.sheetDone }).click();
      await expect(sentence.getByTestId("chip-trip")).toHaveText(he.requestSentence.tripPickupOnly);
      await expect(sentence.getByTestId("chip-origin")).toContainText("בנימינה עצמאי");
      await expect(sentence.getByTestId("chip-destination")).toContainText(home);

      // the trip sheet shows the three kinds; "רק הקפצה" turns the places around, "רק איסוף" back
      await expect(page.getByRole("dialog", { name: he.requestSentence.sheet.trip })).toHaveCount(0);
      await sentence.getByTestId("chip-trip").click();
      await expect(page.getByTestId("drop-off-mode-pickup")).toHaveAttribute("data-state", "on");
      await page.getByTestId("drop-off-mode-drop").click();
      await expect(sentence.getByTestId("chip-destination")).toContainText("בנימינה עצמאי");
      await page.getByTestId("drop-off-mode-pickup").click();
      await page.getByRole("button", { name: he.requestSentence.sheetDone }).click();
      await expect(sentence.getByTestId("chip-trip")).toHaveText(he.requestSentence.tripPickupOnly);
      await expect(sentence.getByTestId("chip-origin")).toContainText("בנימינה עצמאי");
      await expect(sentence.getByTestId("chip-destination")).toContainText(home);
      await expect(sentence.getByTestId("chip-out")).toContainText(he.requestSentence.anchor.pickupAt);

      await submitRequestForm(page);
      await expect(page).toHaveURL(/\/my$/);
      await expect.poll(async () => (await service.from("requests").select("trip_type, origin_text, return_at")
        .eq("requester_id", me!.id).gte("created_at", startedAt)).data)
        .toEqual([{ trip_type: "drop_off", origin_text: "בנימינה עצמאי", return_at: null }]);
    } finally {
      await service.from("requests").delete().eq("requester_id", me!.id).gte("created_at", startedAt).eq("origin_text", "בנימינה עצמאי");
    }
  });

  test("the who chip starts the sentence; stage 2 holds the modifiers and the recap goes back", async ({ page }) => {
    await signIn(page, SEEDED_USERS.member2);
    await page.goto("/requests/new");
    await dismissGuide(page);
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
    await dismissGuide(page);
    await expect(page.getByTestId("request-sentence")).toBeVisible();

    await page.goto("/profile");
    await page.getByLabel(he.profileExtra.classicRequestFormLabel).click();
    await expect(page.getByLabel(he.profileExtra.classicRequestFormLabel)).toBeChecked();

    await page.goto("/requests/new");
    await expect(page.getByTestId("request-sentence")).toHaveCount(0);
    await expect(page.getByRole("combobox").filter({ hasText: he.field.destination })).toBeVisible();
  });
});
