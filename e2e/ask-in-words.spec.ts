import { expect, test, type Page } from "@playwright/test";

import { he } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, signIn, submitRequestForm } from "./helpers";
import { PLACES, PROFILE_IDS, dayOfWeek, deleteRequests, dismissGuide, memberOpenWeek, type MemberWeek } from "./request-form";

// REQ item 258 (AI1), UX_FLOWS §3.4b: "+" → "לכתוב במילים" → the draft card → the regular form filled in → sent; the
// conversation records each step. The `ask` edge function is replaced in the browser (CI never calls Google); the
// conversation row it would create is made here, so the real `finish_ask_conversation` runs against it.
test.use({ viewport: { width: 390, height: 844 } });

const member = SEEDED_USERS.member2;
const memberId = PROFILE_IDS.member2;

async function mockAsk(page: Page, options: { available: boolean; conversationId?: string; day?: string }) {
  await page.route("**/functions/v1/ask", async (route) => {
    const body = route.request().postDataJSON() as { probe?: boolean };
    if (body?.probe) return route.fulfill({ json: options.available ? { available: true } : { available: false, code: "ask_not_configured" } });
    return route.fulfill({
      json: {
        conversation_id: options.conversationId, turn_id: null, refs: {}, rides: [], people: {},
        draft: {
          intent: "new_request", date: options.day, time_mode: "arrive_by", time: "10:00", return_time: null, trip_type: null,
          destination: { text: "בנימינה", list_name: PLACES.binyamina.name }, origin: null, stops: [], people: [], remove_people: [],
          extra_adults: null, needs: [], ask: null, target_ride: null, ride_choices: [], flags: [],
        },
      },
    });
  });
}

test.describe("ask in words", { tag: ["@ask-in-words", "@request-form"] }, () => {
  let week: MemberWeek;
  const requestIds: string[] = [];

  test.beforeAll(async () => {
    const service = serviceRoleClient();
    week = await memberOpenWeek();
    await service.from("profiles").update({ classic_request_form: false }).eq("email", member.email);
    await service.from("ask_access").delete().eq("profile_id", memberId);
    const { error } = await service.from("ask_access").insert({ profile_id: memberId, granted_by: PROFILE_IDS.admin });
    if (error) throw error;
  });
  test.afterAll(async () => {
    const service = serviceRoleClient();
    await service.from("ask_conversations").delete().eq("profile_id", memberId);
    await service.from("ask_access").delete().eq("profile_id", memberId);
    await service.from("profiles").update({ classic_request_form: true }).eq("email", member.email);
    await deleteRequests(service, requestIds);
    await week.cleanup();
  });

  test("the draft card fills the regular form, and the conversation records what was sent", async ({ page }) => {
    const service = serviceRoleClient();
    const { data: conversation, error } = await service.from("ask_conversations")
      .insert({ profile_id: memberId, department_id: NEVO_DEPARTMENT_ID }).select("id").single();
    if (error) throw error;
    const day = dayOfWeek(week.weekStart, 1);
    await mockAsk(page, { available: true, conversationId: conversation.id, day });

    await signIn(page, member);
    await page.goto("/my");
    await page.getByTestId("new-request-button").click();
    await expect(page.getByTestId("ask-or-form-sheet")).toBeVisible();
    await page.getByTestId("ask-choice-ask").click();

    // First open: the disclaimer, remembered on the server.
    await expect(page.getByTestId("ask-disclaimer")).toBeVisible();
    await page.getByRole("button", { name: he.ask.disclaimerOk }).click();
    await expect.poll(async () => (await service.from("ask_access").select("disclaimer_ack_at").eq("profile_id", memberId).single()).data?.disclaimer_ack_at).not.toBeNull();

    const chat = page.getByTestId("ask-chat-sheet");
    await chat.getByTestId("ask-input").fill("בנימינה ביום שני עד 10");
    await chat.getByTestId("ask-send").click();
    const card = chat.getByTestId("ask-draft-card");
    await expect(card.getByTestId("ask-row-time")).toContainText("להגיע עד 10:00");
    // No "when are you back?" (owner 2026-11-20): an estimated return, marked as such.
    await expect(card.getByTestId("ask-row-back")).toContainText(he.ask.backAssumed.replace("{{time}}", "").trim());
    await expect(chat.getByTestId("ask-question")).toHaveCount(0);

    // "רק הלוך" is the app's own chip: the draft changes here, no new turn.
    await chat.getByRole("button", { name: he.ask.oneWayOnly }).click();
    await expect(card.getByTestId("ask-row-back")).toHaveCount(0);
    await chat.getByTestId("ask-to-form").click();

    await expect(page.getByTestId("request-overlay")).toBeVisible();
    await dismissGuide(page);
    await expect(page.getByTestId("ask-prefill-line")).toContainText("בנימינה");
    const sentence = page.getByTestId("request-sentence");
    await expect(sentence.getByTestId("chip-destination")).toContainText(PLACES.binyamina.name);
    await expect.poll(async () => (await service.from("ask_conversations").select("outcome").eq("id", conversation.id).single()).data?.outcome).toBe("to_form");

    await submitRequestForm(page);
    await expect.poll(async () => (await service.from("ask_conversations").select("outcome, result_request_id").eq("id", conversation.id).single()).data?.outcome).toBe("done");
    const { data: done } = await service.from("ask_conversations").select("result_request_id, sent").eq("id", conversation.id).single();
    expect(done?.result_request_id).toBeTruthy();
    requestIds.push(done!.result_request_id!);
    expect(JSON.stringify(done?.sent)).not.toContain("notes");
    const { data: request } = await service.from("requests").select("destination_id, trip_type").eq("id", done!.result_request_id!).single();
    expect(request).toMatchObject({ destination_id: PLACES.binyamina.id, trip_type: "one_way" });
  });

  test("without a working key the option is greyed out before anything is typed", async ({ page }) => {
    await mockAsk(page, { available: false });
    await signIn(page, member);
    await page.goto("/my");
    await page.getByTestId("new-request-button").click();
    const ask = page.getByTestId("ask-choice-ask");
    await expect(ask).toBeDisabled();
    await expect(page.getByTestId("ask-choice-ask-sub")).toHaveText(he.ask.unavailable);
    await page.getByTestId("ask-choice-form").click();
    await expect(page.getByTestId("request-overlay")).toBeVisible();
  });
});
