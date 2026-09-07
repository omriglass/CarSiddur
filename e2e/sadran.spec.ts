import { expect, test } from "@playwright/test";
import { serviceRoleClient, NEVO_DEPARTMENT_ID } from "./helpers";
import { he } from "../src/i18n/he";

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

  test("creates a shift proposal and prepares WhatsApp in a dialog", async ({ page }) => {
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

    await page.getByRole("button", { name: /פתח בוואטסאפ/ }).first().click();
    const waLink = page.locator('a[href^="https://wa.me/"]').first();
    await expect(waLink).toBeVisible({ timeout: 10_000 });
    await expect(waLink).toHaveAttribute("href", /^https:\/\/wa\.me\/\d+\?text=/);
    await expect(waLink).not.toHaveAttribute("target", "_blank");
    await page.keyboard.press("Escape");
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

    await page.goto(`${weekUrl}/publish`);
    await expect(page.getByRole("heading", { name: "פרסום הסידור" })).toBeVisible();

    await page.getByRole("button", { name: "פרסם ושלח הודעות" }).click();
    await expect(page).toHaveURL(weekUrl);

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
