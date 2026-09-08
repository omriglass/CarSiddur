import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { he } from "../src/i18n/he";
import {
  getWeekStart, NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS,
  serviceRoleClient, SUPABASE_ANON_KEY, SUPABASE_URL,
} from "./helpers";

test("weekly member manages only their assigned board while permanent Sadran retains access", async ({ browser }) => {
  const database = serviceRoleClient();
  const admin = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: loginError } = await admin.auth.signInWithPassword(SEEDED_USERS.admin);
  if (loginError) throw loginError;
  const week = await getWeekStart("open");
  const otherWeek = await getWeekStart("live");
  const { data: member, error: memberError } = await database.from("profiles")
    .select("id").eq("email", SEEDED_USERS.member1.email).single();
  if (memberError) throw memberError;
  const { data: original, error: originalError } = await database.from("sadran_assignments")
    .select("profile_id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
  if (originalError) throw originalError;
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
      await temporary.page.getByRole("button", { name: he.action.autoSolveRemaining, exact: true }).click();
      expect((await applied).ok()).toBe(true);
      await temporary.page.goto(`/sadran/${NEVO_DEPARTMENT_ID}/${otherWeek}/board`);
      await expect(temporary.page).toHaveURL(new RegExp(`${boardPath}$`));
      await temporary.page.goto("/admin/settings");
      await expect(temporary.page).toHaveURL(/\/my$/);
      await temporary.page.goto(`/sadran/${NEVO_DEPARTMENT_ID}/${week}/proposals`);
      await expect(temporary.page).toHaveURL(/\/proposals$/);
      await temporary.page.getByRole("combobox").filter({ hasText: he.field.destination }).click();
      await temporary.page.getByRole("option").first().click();
      await temporary.page.getByRole("button", { name: he.action.propose, exact: true }).click();
      await expect(temporary.page).toHaveURL(/\/proposals\/new$/);
      const sent = temporary.page.waitForResponse((response) =>
        response.url().endsWith("/rest/v1/rpc/send_proposal") && response.request().method() === "POST");
      await temporary.page.getByRole("button", { name: he.action.propose, exact: true }).click();
      expect((await sent).ok()).toBe(true);
      await expect(temporary.page).toHaveURL(new RegExp(`/${week}/proposals$`));
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
    await assign((original ?? []).map((row) => row.profile_id));
    await admin.auth.signOut();
  }
});
