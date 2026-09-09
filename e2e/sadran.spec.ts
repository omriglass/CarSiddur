import { expect, test } from "@playwright/test";
import { serviceRoleClient, NEVO_DEPARTMENT_ID } from "./helpers";
import { he } from "../src/i18n/he";

/**
 * A standalone week + request (rather than the shared seeded Open week) so this test's proposal
 * doesn't depend on whether "opens the board and fills remaining requests" (above, same file)
 * already auto-solved every unmet request there — `handleAutoSolveRemaining` mode "remaining"
 * places every currently-unmet request it can, so nothing would necessarily be left to act on.
 */
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
    trip_shape: "round_trip", depart_at: `${week}T08:00:00Z`, return_at: `${week}T10:00:00Z`, adults: 1, status: "submitted",
  }).select("id").single();
  if (requestError) throw requestError;
  return { service, cleanup, request: request!, baseUrl: `/sadran/${NEVO_DEPARTMENT_ID}/${week}` };
}

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
  test("opens the board directly and fills the remaining requests", async ({ page }) => {
    await signIn(page);

    await page.goto("/sadran");
    await expect(page).toHaveURL(/\/sadran\/[\w-]+\/\d{4}-\d{2}-\d{2}\/board$/);
    await expect(page.getByRole("heading", { name: he.screen.board.title })).toBeVisible();
    const applied = page.waitForResponse((response) => response.url().endsWith("/rest/v1/rpc/apply_solver_result") && response.request().method() === "POST");
    await page.getByRole("button", { name: he.action.autoSolveRemaining, exact: true }).click();
    expect((await applied).ok()).toBe(true);

    await expect(page).toHaveURL(/\/board$/);
    await expect(page.getByRole("heading", { name: "לוח הסידור" })).toBeVisible();
  });

  test("creates a shift proposal and prepares WhatsApp in a dialog", async ({ page }) => {
    await signIn(page);

    // New proposals are only ever created from the board's unmet-request action button — the
    // manual composer entry point in ProposalsListScreen.tsx was removed.
    const fixture = await proposalFixture("2043-02-08", "E2E sadran spec proposal");
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${fixture.baseUrl}/board`);
      await page.locator(`[data-request-id="${fixture.request.id}"]`).getByRole("button", {
        name: he.sadranProposal.suggestTimes, exact: true,
      }).click();
      await expect(page).toHaveURL(/\/proposals\/new$/);
      await page.getByRole("button", { name: he.action.propose, exact: true }).click();

      await expect(page).toHaveURL(`${fixture.baseUrl}/board`);
      await page.getByRole("button", { name: he.sadranProposal.openSentProposal, exact: true }).click();
      await page.getByRole("button", { name: /פתח בוואטסאפ/ }).first().click();
      const waLink = page.locator('a[href^="https://wa.me/"]').first();
      await expect(waLink).toBeVisible({ timeout: 10_000 });
      await expect(waLink).toHaveAttribute("href", /^https:\/\/wa\.me\/\d+\?text=/);
      await expect(waLink).not.toHaveAttribute("target", "_blank");
      await page.keyboard.press("Escape");
    } finally {
      await fixture.cleanup();
    }
  });

  test("publishes the week and sees a siddur version", async ({ page }) => {
    // Fixed in Stage 3 hardening (supabase/migrations/20260907092500_fix_publish_siddur_notified_count.sql,
    // DATA_MODEL.md §6.1 item 16, UX_FLOWS.md §16 item 1): `publish_siddur()` now computes
    // `notified_count` before the `siddur_versions` insert instead of updating it after, so
    // the immutability trigger is never exercised. Un-skipped accordingly.
    await signIn(page);
    await page.goto("/sadran");
    await expect(page).toHaveURL(/\/sadran\/[\w-]+\/\d{4}-\d{2}-\d{2}\/board$/);
    const weekUrl = page.url().replace(/\/board$/, "");
    const weekStart = weekUrl.split("/").at(-1)!;
    const service = serviceRoleClient();
    const policyId = "00000000-0000-0000-0000-00000000e091";
    const versionId = "00000000-0000-0000-0000-00000000e092";
    const { data: existing } = await service.from("policies").select("id").eq("id", policyId).maybeSingle();
    if (!existing) {
      const { error: policyError } = await service.from("policies").insert({ id: policyId, department_id: NEVO_DEPARTMENT_ID, name: "E2E inactive comparison", is_active: false });
      if (policyError) throw policyError;
      const { error: versionError } = await service.from("policy_versions").insert({ id: versionId, policy_id: policyId, created_by: "00000000-0000-0000-0000-000000000101", rules: [{ type: "rideType", weight: 1, params: { weights: { healthcare: 1, work: 1, other: 1 } } }] });
      if (versionError) throw versionError;
      const { error: currentError } = await service.from("policies").update({ current_version_id: versionId }).eq("id", policyId);
      if (currentError) throw currentError;
    }

    await page.getByRole("button", { name: he.publicationFlow.closeAndPublish, exact: true })
      .or(page.getByRole("button", { name: he.action.publish, exact: true })).click();
    await expect(page).toHaveURL(`${weekUrl}/publish`);
    await expect(page.getByRole("heading", { name: he.screen.publish.title })).toBeVisible();
    await page.getByRole("button", { name: he.publicationFlow.allYes, exact: true }).click();
    const confirm = page.getByRole("button", { name: he.publicationFlow.confirmUnresolved, exact: true });
    await expect.poll(async () => page.url().endsWith("/board") || await confirm.isVisible()).toBe(true);
    if (await confirm.isVisible()) await confirm.click();
    await expect(page).toHaveURL(`${weekUrl}/board`);

    await page.goto(`${weekUrl}/publish`);
    await expect(page.getByText("קודמת: גרסה", { exact: false })).toBeVisible();
    await expect(page.getByRole("heading", { name: he.publishScores.title })).toBeVisible();
    await expect(page.getByRole("cell", { name: "E2E inactive comparison" })).toBeVisible();
    const { data: snapshot } = await service.from("siddur_versions").select("snapshot").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", weekStart).order("version_no", { ascending: false }).limit(1).single();
    const scores = snapshot!.snapshot.policy_scores as { policy_id: string; policy_version_id: string; request_count: number; served_count: number; profiles: unknown[] }[];
    expect(scores.length).toBeGreaterThanOrEqual(2);
    expect(scores.find((s) => s.policy_id === policyId)?.policy_version_id).toBe(versionId);
    expect(new Set(scores.map((s) => s.request_count)).size).toBe(1);
    expect(new Set(scores.map((s) => s.served_count)).size).toBe(1);
    expect(scores.every((s) => s.profiles.length > 0)).toBe(true);
  });
});
