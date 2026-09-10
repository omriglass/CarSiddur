import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { he } from "../src/i18n/he";
import {
  getWeekStart, NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS,
  serviceRoleClient, SUPABASE_ANON_KEY, SUPABASE_URL,
} from "./helpers";

// A dedicated fixture week (own Sunday, far from the seed) rather than `getWeekStart("open")`:
// the seed has exactly one Open week, and other specs that run earlier in a full suite
// (sadran.spec.ts's "publishes the week" test) advance it to `published`, so depending on it
// here raced with test order. This spec owns its own week end-to-end instead.
const WEEK = "2043-02-15";

test("weekly member manages only their assigned board while permanent Sadran retains access", async ({ browser }) => {
  const database = serviceRoleClient();
  const admin = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: loginError } = await admin.auth.signInWithPassword(SEEDED_USERS.admin);
  if (loginError) throw loginError;
  const week = WEEK;
  const otherWeek = await getWeekStart("live");
  async function cleanupWeek() {
    await database.from("proposals").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    await database.from("notifications").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    await database.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    await database.from("sadran_assignments").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    await database.from("weeks").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
  }
  await cleanupWeek();
  const at = (daysBefore: number) => new Date(Date.parse(`${week}T00:00:00Z`) - daysBefore * 86400000).toISOString();
  const { error: weekError } = await database.from("weeks").insert({
    department_id: NEVO_DEPARTMENT_ID, week_start: week, phase: "open",
    open_at: at(7), close_at: at(3), publish_at: at(2),
  });
  if (weekError) throw weekError;
  const { data: member, error: memberError } = await database.from("profiles")
    .select("id").eq("email", SEEDED_USERS.member1.email).single();
  if (memberError) throw memberError;
  async function assign(profileIds: string[]) {
    const { error } = await admin.rpc("admin_set_sadran_assignments", {
      p_department_id: NEVO_DEPARTMENT_ID, p_week_start: week, p_profile_ids: profileIds,
    });
    if (error) throw error;
  }
  await assign([member.id]);
  try {
    const { data: membership, error } = await database.from("department_members").select("role")
      .eq("department_id", NEVO_DEPARTMENT_ID).eq("profile_id", member.id).single();
    if (error) throw error;
    expect(membership.role).toBe("member");
    const temporary = await newSignedInPage(browser, SEEDED_USERS.member1);
    try {
      const boardPath = `/sadran/${NEVO_DEPARTMENT_ID}/${week}/board`;
      await temporary.page.getByRole("link", { name: he.nav.sadran, exact: true }).first().click();
      await expect(temporary.page).toHaveURL(new RegExp(`${boardPath}$`));
      await expect(temporary.page.getByRole("link", { name: he.nav.admin, exact: true })).toHaveCount(0);
      await expect(temporary.page.getByRole("heading", { name: he.screen.board.title })).toBeVisible();
      const applied = temporary.page.waitForResponse((response) =>
        response.url().endsWith("/rest/v1/rpc/apply_solver_result") && response.request().method() === "POST");
      // "השלם אוטומטית" now lives in the board's kebab "actions" menu (UX_FLOWS.md §4.2, 2026-09-10) at every width.
      await temporary.page.getByRole("button", { name: he.sadranBoard.actionsMenu, exact: true }).click();
      await temporary.page.getByRole("menuitem", { name: he.action.autoSolveRemaining, exact: true }).click();
      expect((await applied).ok()).toBe(true);
      await temporary.page.goto(`/sadran/${NEVO_DEPARTMENT_ID}/${otherWeek}/board`);
      await expect(temporary.page).toHaveURL(new RegExp(`${boardPath}$`));
      await temporary.page.goto("/admin/settings");
      await expect(temporary.page).toHaveURL(/\/my$/);
      // Proposals list stays reachable (permission), but is read/answer-status only now — new
      // proposals are only ever created from the board's unmet-request action button. The
      // "auto solve remaining" click just above may already have placed every pre-existing
      // unmet request in this shared open week, so insert a fresh one directly to have
      // something deterministic to act on (Sunday/index 0, so no day-tab ambiguity).
      const fixtureLabel = "E2E weekly-permission proposal";
      const { data: fixtureRequest, error: fixtureError } = await database.from("requests").insert({
        department_id: NEVO_DEPARTMENT_ID, week_start: week, requester_id: member.id, filed_by: member.id,
        ride_type_id: "00000000-0000-0000-0000-000000000021", destination_text: fixtureLabel,
        trip_shape: "round_trip", depart_at: `${week}T09:00:00Z`, return_at: `${week}T11:00:00Z`,
        adults: 1, status: "submitted",
      }).select("id").single();
      if (fixtureError) throw fixtureError;
      try {
        await temporary.page.goto(`/sadran/${NEVO_DEPARTMENT_ID}/${week}/proposals`);
        await expect(temporary.page).toHaveURL(/\/proposals$/);
        await expect(temporary.page.getByRole("heading", { name: he.screen.proposals.title })).toBeVisible();

        await temporary.page.goto(boardPath);
        await temporary.page.getByRole("radio").nth(0).click();
        const unmetCard = temporary.page.locator(`[data-request-id="${fixtureRequest!.id}"]`);
        await expect(unmetCard).toBeVisible();
        await unmetCard.getByRole("button", { name: he.sadranProposal.suggestTimes, exact: true }).click();
        await expect(temporary.page).toHaveURL(/\/proposals\/new$/);
        const sent = temporary.page.waitForResponse((response) =>
          response.url().endsWith("/rest/v1/rpc/send_proposal") && response.request().method() === "POST");
        await temporary.page.getByRole("button", { name: he.action.propose, exact: true }).click();
        expect((await sent).ok()).toBe(true);
        await expect(temporary.page).toHaveURL(new RegExp(`${boardPath}$`));
      } finally {
        await database.from("proposals").delete().eq("request_id", fixtureRequest!.id);
        await database.from("requests").delete().eq("id", fixtureRequest!.id);
      }
    } finally {
      await temporary.context.close();
    }
    const permanent = await newSignedInPage(browser, SEEDED_USERS.sadran);
    try {
      await permanent.page.goto(`/sadran/${NEVO_DEPARTMENT_ID}/${week}/board`);
      await expect(permanent.page.getByRole("combobox").first()).toBeVisible();
      await expect(permanent.page).toHaveURL(new RegExp(`/${week}/board$`));
      await permanent.page.goto(`/sadran/${NEVO_DEPARTMENT_ID}/${otherWeek}/board`);
      await expect(permanent.page).toHaveURL(new RegExp(`/${otherWeek}/board$`));
    } finally {
      await permanent.context.close();
    }
  } finally {
    await cleanupWeek();
    await admin.auth.signOut();
  }
});
