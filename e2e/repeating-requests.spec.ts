import { expect, test } from "@playwright/test";
import { he, t } from "../src/i18n/he";
import { getWeekStart, NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, signIn } from "./helpers";

// Repeating-request suggestions (REQ §76, UX_FLOWS §3.3/§3.4, built 2026-09-10): submitting with
// the "repeat weekly" switch on creates a `request_templates` row; every later open week without
// a matching request shows a dismissable suggestion card on Home ("לא השבוע" snoozes it one
// week, "הפסק/י לחזור" stops it for good) and prefills `/requests/new` when used.
const DESTINATION = "E2E repeating destination";
const MEMBER_ID = "00000000-0000-0000-0000-000000000103";

test.use({ viewport: { width: 390, height: 844 } });

function addDays(dateKey: string, days: number): string {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Forces `weekStart` into phase `open`, restoring whatever it was before (or deleting it if it
 * didn't exist) once `run()` finishes. The near-term future weeks this test needs may already
 * exist as `upcoming` — the department's look-ahead pipeline (`ensure_upcoming_week()`,
 * `supabase/migrations/20260910095200_ensure_upcoming_week.sql`) maintains those automatically —
 * so this never blindly deletes-and-reinserts (which would also fight that invariant).
 */
async function withOpenWeek<T>(weekStart: string, run: () => Promise<T>): Promise<T> {
  const service = serviceRoleClient();
  const { data: existing } = await service.from("weeks").select("phase").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", weekStart).maybeSingle();
  if (existing) {
    const { error } = await service.from("weeks").update({ phase: "open" }).eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", weekStart);
    if (error) throw error;
  } else {
    const { error } = await service.from("weeks").insert({
      department_id: NEVO_DEPARTMENT_ID, week_start: weekStart, phase: "open",
      open_at: `${weekStart}T00:00:00Z`, close_at: `${addDays(weekStart, 3)}T00:00:00Z`, publish_at: `${addDays(weekStart, 4)}T00:00:00Z`,
    });
    if (error) throw error;
  }
  try {
    return await run();
  } finally {
    if (existing) {
      await service.from("weeks").update({ phase: existing.phase }).eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", weekStart);
    } else {
      await service.from("weeks").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", weekStart);
    }
  }
}

test.describe("repeating requests", () => {
  test("submit with repeat on creates a template; the next open week suggests it; snooze, use and stop all work", async ({ page }) => {
    const service = serviceRoleClient();
    const openWeekStart = await getWeekStart("open");
    const secondOpenWeekStart = addDays(openWeekStart, 7);
    const thirdOpenWeekStart = addDays(openWeekStart, 14);

    async function cleanupTemplates() {
      const { data: templates } = await service.from("request_templates").select("id").eq("requester_id", MEMBER_ID).eq("destination_text", DESTINATION);
      const ids = (templates ?? []).map((row) => row.id);
      if (ids.length) {
        await service.from("requests").update({ template_id: null }).in("template_id", ids);
        await service.from("request_templates").delete().in("id", ids);
      }
    }
    await cleanupTemplates();
    await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("destination_text", DESTINATION);

    let template: { id: string; is_active: boolean } | null = null;
    try {
      await withOpenWeek(secondOpenWeekStart, async () => {
        await signIn(page, SEEDED_USERS.member1);
        await page.goto("/requests/new");
        await expect(page.getByText("בקשה חדשה")).toBeVisible();
        await page.getByRole("combobox").filter({ hasText: "לאן?" }).click();
        await page.getByPlaceholder("לאן?").fill(DESTINATION);
        await page.getByText(`"${DESTINATION}" — יעד חופשי`).click();
        await page.getByRole("radiogroup", { name: "סוג נסיעה" }).getByRole("radio").first().click();
        await page.getByRole("switch", { name: t("request.repeatWeekly") }).click();
        await page.getByRole("button", { name: "הגש/י בקשה" }).click();
        await expect(page).toHaveURL(/\/requests$/);

        const { data } = await service.from("request_templates").select("id, is_active")
          .eq("requester_id", MEMBER_ID).eq("destination_text", DESTINATION).maybeSingle();
        expect(data, "no request_templates row created by submit_request").toBeTruthy();
        expect(data!.is_active).toBe(true);
        template = data;

        // Home suggests it for the second open week.
        await page.goto("/my");
        const suggestions = page.getByTestId("template-suggestions");
        await expect(suggestions).toBeVisible();
        await expect(suggestions.getByText(DESTINATION, { exact: false }).first()).toBeVisible();

        // "לא השבוע" snoozes it away.
        await suggestions.getByRole("button", { name: he.request.snoozeSuggestion, exact: true }).first().click();
        await expect(page.getByText(he.request.snoozed)).toBeVisible();
        // `Home` also lists the member's own submitted requests (CLAUDE.md decision 17) — the
        // destination text alone isn't a reliable "no more suggestion" signal, only the
        // suggestions section's own testid is.
        await expect(page.getByTestId("template-suggestions")).toHaveCount(0);
        const { data: afterSnooze } = await service.from("request_templates").select("snoozed_until_week").eq("id", template!.id).single();
        expect(afterSnooze!.snoozed_until_week).toBeTruthy();

        // Un-snooze (service role) then use the suggestion: it prefills the destination/times
        // and submitting removes it.
        await service.from("request_templates").update({ snoozed_until_week: null }).eq("id", template!.id);
        await page.reload();
        await expect(page.getByTestId("template-suggestions")).toBeVisible();
        await page.getByTestId("template-suggestions").getByRole("link", { name: he.request.useSuggestion, exact: true }).first().click();
        await expect(page).toHaveURL(/\/requests\/new\?.*template=/);
        await expect(page.getByText(DESTINATION)).toBeVisible();
        await page.getByRole("button", { name: "הגש/י בקשה" }).click();
        await expect(page).toHaveURL(/\/requests$/);

        await page.goto("/my");
        await expect(page.getByTestId("template-suggestions")).toHaveCount(0);
      });

      // The third open week (still without a matching request) makes the suggestion
      // reappear — exercises "הפסק/י לחזור" (stop for good).
      await withOpenWeek(thirdOpenWeekStart, async () => {
        await page.goto("/my");
        await expect(page.getByTestId("template-suggestions")).toBeVisible();
        await page.getByTestId("template-suggestions").getByRole("button", { name: he.request.stopSuggestion, exact: true }).first().click();
        await expect(page.getByRole("heading", { name: he.request.stopSuggestionConfirmTitle })).toBeVisible();
        // `ConfirmDialog` here doesn't override `confirmLabel`, so its button reads the
        // default "אישור" (`he.common.confirm`), not the trigger's own "הפסק/י לחזור".
        await page.getByRole("button", { name: he.common.confirm, exact: true }).click();
        await expect(page.getByText(he.request.stopped)).toBeVisible();
        const { data: afterStop } = await service.from("request_templates").select("is_active").eq("id", template!.id).single();
        expect(afterStop!.is_active).toBe(false);
      });
    } finally {
      await cleanupTemplates();
      await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("destination_text", DESTINATION);
    }
  });
});
