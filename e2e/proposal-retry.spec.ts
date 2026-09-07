import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { he, tv } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient, SUPABASE_ANON_KEY, SUPABASE_URL } from "./helpers";

test.use({ actionTimeout: 15_000 });

for (const scenario of [
  { type: "deny", week: "2043-01-18", reason: "", expectedReason: he.sadranProposal.defaultReason },
  { type: "external", week: "2043-01-25", reason: "   ", expectedReason: he.sadranProposal.defaultReason },
  { type: "external", week: "2043-02-01", reason: "Custom coordinator explanation", expectedReason: "Custom coordinator explanation" },
] as const) {
  test(`optional proposal reason: ${scenario.type} ${scenario.reason.trim() ? "custom" : "default"}`, async ({ browser }) => {
    const fixture = await proposalFixture(scenario.week, `E2E optional reason ${scenario.type}`);
    const coordinator = await newSignedInPage(browser, SEEDED_USERS.sadran);
    const page = coordinator.page;
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${fixture.baseUrl}/board`);
      await page.locator(`[data-request-id="${fixture.request.id}"]`).getByRole("button", {
        name: he.sadranProposal.solveOutside, exact: true,
      }).click();
      await expect(page).toHaveURL(/\/proposals\/new$/);
      const tripSummary = page.locator("[data-trip-summary]");
      await expect(tripSummary).toContainText(SEEDED_USERS.member1.fullName);
      await expect(tripSummary).toContainText(`E2E optional reason ${scenario.type}`);
      await expect(tripSummary).toContainText(he.days.long[0]!);
      await expect(tripSummary).toContainText(`${Number(scenario.week.slice(8))}/${Number(scenario.week.slice(5, 7))}/2043`);
      await expect(tripSummary).toContainText("08:00–10:00");
      const { data: rideType } = await fixture.service.from("ride_types").select("name_he").eq("id", "00000000-0000-0000-0000-000000000021").single();
      await expect(tripSummary).toContainText(rideType!.name_he);
      const reason = page.getByLabel(he.sadranProposal.reasonLabel, { exact: true });
      await expect(reason).toHaveValue("");
      await reason.fill(scenario.reason);
      await page.getByRole("combobox").last().click();
      await page.getByRole("option", { name: scenario.type === "external" ? he.sadranProposal.hintPublicTransport : he.sadranProposal.hintWaive, exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: he.action.propose, exact: true }).click();
      await expect(page).toHaveURL(`${fixture.baseUrl}/board`);
      await page.getByRole("button", { name: he.sadranProposal.openSentProposal, exact: true }).click();
      await expect(page.getByText(he.sadranProposal.pushNote)).toBeVisible();
      const { data: proposal, error } = await fixture.service.from("proposals").select("status,payload,reason_he").eq("request_id", fixture.request.id).single();
      if (error) throw error;
      expect(proposal!.status).toBe("sent");
      expect(proposal!.payload.reason).toBe(scenario.expectedReason);
      expect(proposal!.reason_he).toContain(scenario.expectedReason);
      if (scenario.type === "external") {
        expect(proposal!.payload.hint).toBe("public_transport");
        expect(proposal!.reason_he).toContain(he.sadranProposal.externalSuggestion.public_transport);
        expect(proposal!.reason_he).not.toContain(he.sadranProposal.externalSuggestion.cab);
      }
      await whatsappToken(page);
    } finally {
      await coordinator.context.close();
      await fixture.cleanup();
    }
  });
}

async function proposalFixture(week: string, label: string) {
  const service = serviceRoleClient();
  async function cleanup() {
    await service.from("proposals").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    await service.from("notifications").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    await service.from("weeks").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
  }
  await cleanup();
  const at = (days: number) => new Date(Date.parse(`${week}T00:00:00Z`) - days * 86400000).toISOString();
  const { error: weekError } = await service.from("weeks").insert({ department_id: NEVO_DEPARTMENT_ID, week_start: week, phase: "open", open_at: at(7), close_at: at(3), publish_at: at(2) });
  if (weekError) throw weekError;
  const memberId = "00000000-0000-0000-0000-000000000103";
  const { data: request, error: requestError } = await service.from("requests").insert({
    department_id: NEVO_DEPARTMENT_ID, week_start: week, requester_id: memberId, filed_by: memberId,
    ride_type_id: "00000000-0000-0000-0000-000000000021", destination_text: label,
    trip_shape: "round_trip", depart_at: `${week}T08:00:00+02:00`, return_at: `${week}T10:00:00+02:00`, status: "submitted",
  }).select("id,depart_at,return_at").single();
  if (requestError) throw requestError;
  return { service, cleanup, request: request!, memberId, baseUrl: `/sadran/${NEVO_DEPARTMENT_ID}/${week}` };
}

async function composeFromBoard(page: Page, baseUrl: string, requestId: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/board`);
  await page.locator(`[data-request-id="${requestId}"]`).getByRole("button", { name: he.sadranProposal.suggestTimes, exact: true }).click();
  await expect(page).toHaveURL(/\/proposals\/new$/);
}

async function whatsappToken(page: Page): Promise<string> {
  await page.getByRole("button", { name: tv("sadranProposal.sendWhatsapp", { name: SEEDED_USERS.member1.fullName }) }).first().click();
  const link = page.locator('a[href^="https://wa.me/"]');
  await expect(link).toBeVisible();
  const message = new URL((await link.getAttribute("href"))!).searchParams.get("text") ?? "";
  const token = message.match(/\/p\/([\w-]+)/)?.[1];
  expect(token, "WhatsApp preview includes a concrete personal proposal token").toBeTruthy();
  expect(message).not.toContain("{{link}}");
  await page.getByRole("button", { name: he.whatsappDialog.close, exact: true }).click();
  return token!;
}

test("board proposal action shows the sent proposal and explicitly replaces it with a valid new token", async ({ browser }) => {
  const fixture = await proposalFixture("2043-01-04", "E2E explicit proposal replacement");
  const admin = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const contexts: { close: () => Promise<void> }[] = [];
  try {
    const { error: authError } = await admin.auth.signInWithPassword(SEEDED_USERS.admin);
    if (authError) throw authError;
    const { data: oldId, error: createError } = await admin.rpc("create_proposal", { p_request_id: fixture.request.id, p_type: "shift", p_ride_id: null,
      p_payload: { depart_at: fixture.request.depart_at, return_at: fixture.request.return_at }, p_reason_he: "E2E existing sent proposal", p_party_profile_ids: [], p_created_via: "sadran" });
    if (createError) throw createError;
    const { data: oldSent, error: sendError } = await admin.rpc("send_proposal", { p_proposal_id: oldId, p_sent_via: [] });
    if (sendError) throw sendError;
    const coordinator = await newSignedInPage(browser, SEEDED_USERS.sadran);
    contexts.push(coordinator.context);
    const page = coordinator.page;
    const errors: string[] = [];
    page.on("response", (response) => { if (response.url().includes("/rest/v1/rpc/") && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    await composeFromBoard(page, fixture.baseUrl, fixture.request.id);
    await expect(page.getByText(he.sadranProposal.pendingProposalNote)).toBeVisible();
    await page.getByRole("button", { name: he.sadranProposal.viewPendingProposal, exact: true }).click();
    await expect(page.getByText(he.sadranProposal.pushNote)).toBeVisible();
    expect((await fixture.service.from("proposals").select("id").eq("request_id", fixture.request.id)).data).toHaveLength(1);

    await composeFromBoard(page, fixture.baseUrl, fixture.request.id);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: he.sadranProposal.replaceAndSend, exact: true }).click();
    await expect(page).toHaveURL(`${fixture.baseUrl}/board`);
    await page.getByRole("button", { name: he.sadranProposal.openSentProposal, exact: true }).click();
    await expect(page.getByText(he.sadranProposal.pushNote)).toBeVisible();
    const { data: proposals, error: readError } = await fixture.service.from("proposals").select("id,status").eq("request_id", fixture.request.id);
    if (readError) throw readError;
    expect(proposals).toHaveLength(2);
    expect(proposals!.find((proposal) => proposal.id === oldId)?.status).toBe("expired");
    expect(proposals!.filter((proposal) => proposal.status === "sent")).toHaveLength(1);
    const token = await whatsappToken(page);
    expect(token).not.toBe(oldSent.party_tokens[fixture.memberId]);
    expect(errors).toEqual([]);
    await expect(page.getByText(he.errors.unknown, { exact: true })).toHaveCount(0);
    const anonymous = await browser.newContext();
    contexts.push(anonymous);
    const recipient = await anonymous.newPage();
    await recipient.goto(`/p/${token}`);
    await expect(recipient.getByRole("button", { name: he.action.acceptProposal, exact: true })).toBeVisible();
    await recipient.goto(`/p/${oldSent.party_tokens[fixture.memberId]}`);
    await expect(recipient.getByText(he.proposalScreen.alreadyAnsweredBy)).toBeVisible();
    await expect(recipient.getByRole("button", { name: he.action.acceptProposal, exact: true })).toHaveCount(0);
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await admin.auth.signOut();
    await fixture.cleanup();
  }
});

test("failed first send reopens as a sendable draft and retries the same proposal without creating another", async ({ browser }) => {
  const label = "E2E proposal draft retry";
  const fixture = await proposalFixture("2043-01-11", label);
  const coordinator = await newSignedInPage(browser, SEEDED_USERS.sadran);
  const page = coordinator.page;
  let creates = 0;
  const sentIds: string[] = [];
  page.on("request", (request) => { if (request.url().endsWith("/rest/v1/rpc/create_proposal")) creates++; });
  await page.route("**/rest/v1/rpc/send_proposal", async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    sentIds.push(route.request().postDataJSON().p_proposal_id as string);
    if (sentIds.length === 1) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "E2E_TEMPORARY", message: "injected first-send failure" }) });
    else await route.continue();
  });
  try {
    await composeFromBoard(page, fixture.baseUrl, fixture.request.id);
    await page.getByRole("button", { name: he.action.propose, exact: true }).click();
    await expect(page.getByRole("button", { name: he.sadranProposal.retrySend, exact: true })).toBeVisible();
    const { data: draft } = await fixture.service.from("proposals").select("id,status").eq("request_id", fixture.request.id).single();
    expect(draft?.status).toBe("draft");
    expect(creates).toBe(1);
    await page.goto(`${fixture.baseUrl}/proposals`);
    await page.getByText(`${he.proposal.type.shift} · ${label}`, { exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: he.sadranProposal.retrySend, exact: true }).click();
    await expect(page).toHaveURL(`${fixture.baseUrl}/proposals`);
    // Reopening from the list (without the success-toast action) retains WhatsApp links.
    await page.getByText(`${he.proposal.type.shift} · ${label}`, { exact: true }).click();
    await expect(page.getByText(he.sadranProposal.pushNote)).toBeVisible();
    expect(creates).toBe(1);
    expect(sentIds).toEqual([draft!.id, draft!.id]);
    const { data: sent } = await fixture.service.from("proposals").select("id,status").eq("request_id", fixture.request.id);
    expect(sent).toEqual([{ id: draft!.id, status: "sent" }]);
    await whatsappToken(page);
  } finally {
    await coordinator.context.close().catch(() => undefined);
    await fixture.cleanup();
  }
});
