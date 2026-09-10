import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { he } from "../src/i18n/he";
import {
  NEVO_DEPARTMENT_ID,
  SEEDED_USERS,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  newSignedInPage,
  serviceRoleClient,
} from "./helpers";

// Contested waiting-list groups (REQ §13.75, UX_FLOWS.md §3.5/§4.2, owner decision 2026-09-10):
// two members file overlapping round-trip requests for a day where only one shared car is
// actually free — `form_waitlist_groups()` (called from `publish_siddur()`) can't auto-approve
// both onto separate cars, so it groups them into one "בדיון" block instead of leaving either
// unresolved. Either participant (or the Sadran) resolves it by ticking who rides and who
// drives; the rest stay on the waiting list. A non-participant only gets a read-only hint.
const MEMBER1_ID = "00000000-0000-0000-0000-000000000103";
const MEMBER2_ID = "00000000-0000-0000-0000-000000000104";
const ADMIN_ID = "00000000-0000-0000-0000-000000000101";
const RIDE_TYPE_ID = "00000000-0000-0000-0000-000000000021";

/**
 * A fresh, never-before-used Sunday, offset by `salt` so the two tests in this file never
 * race on the same week. `weeks` rows can never be deleted once published — `siddur_versions`
 * (immutable history, `forbid_mutation()`) carries a composite FK to them — so reusing a fixed
 * week_start across repeated local test runs eventually collides; a unique one every run avoids
 * that instead of trying to tear down rows the schema deliberately keeps forever.
 */
function uniqueFutureWeek(salt: number): { weekStart: string; day: string } {
  const knownSunday = Date.UTC(2050, 0, 2);
  const weeksAhead = (Math.floor(Date.now() / 1000) % 20_000) + salt;
  const start = knownSunday + weeksAhead * 7 * 86_400_000;
  return { weekStart: new Date(start).toISOString().slice(0, 10), day: new Date(start + 2 * 86_400_000).toISOString().slice(0, 10) };
}

/** Publishes `day` (only) as the standing Sadran; `form_waitlist_groups()` runs inside `publish_siddur()`. */
async function publishDay(departmentId: string, weekStart: string, day: string): Promise<void> {
  const sadranClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { error: authError } = await sadranClient.auth.signInWithPassword(SEEDED_USERS.sadran);
  if (authError) throw authError;
  const fingerprintArgs = { p_department_id: departmentId, p_week_start: weekStart };
  const { data: fingerprint, error: fingerprintError } = await sadranClient.rpc("publish_scores_fingerprint", fingerprintArgs);
  if (fingerprintError) throw fingerprintError;
  const { error: publishError } = await sadranClient.rpc("publish_siddur", {
    ...fingerprintArgs, p_expected_fingerprint: fingerprint, p_profile_scores: [], p_policy_scores: [], p_days: [day],
  });
  if (publishError) throw publishError;
}

/** Blocks every shared car except one for the whole `day`, so two overlapping requests contest the one that's left. */
async function leaveOneSharedCarFree(departmentId: string, day: string): Promise<{ freeCarId: string }> {
  const service = serviceRoleClient();
  // `resolve_waitlist_group()`'s own fallback car search is `order by c.id limit 1` (no
  // maintenance-block filter in that query at all — only the ride insert itself rejects a
  // blocked car) — mirror that exact order here so the one car left free is the one it will
  // actually pick, not an arbitrarily-ordered "first" row.
  const { data: sharedCars, error } = await service.from("cars").select("id").eq("department_id", departmentId).eq("type", "shared").eq("status", "active").order("id", { ascending: true });
  if (error) throw error;
  expect(sharedCars!.length, "need at least 2 active shared cars in the seed to force a contest").toBeGreaterThan(1);
  const [freeCar, ...blockedCars] = sharedCars!;
  const { error: blockError } = await service.from("car_maintenance_blocks").insert(blockedCars.map((car) => ({
    car_id: car.id, department_id: departmentId, reason: "E2E waitlist-groups fixture",
    starts_at: `${day}T00:00:00Z`, ends_at: `${day}T23:45:00Z`, created_by: ADMIN_ID,
  })));
  if (blockError) throw blockError;
  return { freeCarId: freeCar!.id };
}

test.describe("waitlist groups", () => {
  test("two overlapping requests on a single-car day form a discussion block; resolving merges them into one ride", async ({ browser }) => {
    const service = serviceRoleClient();
    const { weekStart, day } = uniqueFutureWeek(1);

    const { error: weekError } = await service.from("weeks").insert({
      department_id: NEVO_DEPARTMENT_ID, week_start: weekStart, phase: "open",
      open_at: `${weekStart}T00:00:00Z`, close_at: `${day}T00:00:00Z`, publish_at: `${day}T00:00:00Z`,
    });
    if (weekError) throw weekError;
    const { freeCarId } = await leaveOneSharedCarFree(NEVO_DEPARTMENT_ID, day);

    const requesters = [MEMBER1_ID, MEMBER2_ID];
    const { data: requests, error: requestsError } = await service.from("requests").insert(
      requesters.map((requesterId) => ({
        department_id: NEVO_DEPARTMENT_ID, week_start: weekStart, requester_id: requesterId, filed_by: requesterId,
        ride_type_id: RIDE_TYPE_ID, destination_text: "E2E waitlist group destination", trip_shape: "round_trip",
        depart_at: `${day}T07:00:00+02:00`, return_at: `${day}T09:00:00+02:00`, adults: 1, status: "submitted",
      })),
    ).select("id, requester_id");
    if (requestsError) throw requestsError;

    await publishDay(NEVO_DEPARTMENT_ID, weekStart, day);

    const { data: group } = await service.from("waitlist_groups").select("id, version")
      .eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", weekStart).eq("day", day).eq("status", "open").maybeSingle();
    expect(group, "no contested waitlist group formed — check car availability/overlap setup").toBeTruthy();

    const { data: requestsAfter } = await service.from("requests").select("id, status").in("id", requests!.map((r) => r.id));
    expect(requestsAfter!.every((r) => r.status === "waitlisted")).toBe(true);

    // Member A (participant) opens the published day and resolves the discussion.
    const memberA = await newSignedInPage(browser, SEEDED_USERS.member1);
    try {
      await memberA.page.setViewportSize({ width: 390, height: 844 });
      await memberA.page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${weekStart}`);
      await memberA.page.getByRole("radio", { name: "ג", exact: true }).click();
      const discussionCard = memberA.page.getByRole("button", { name: /בדיון:/ });
      await expect(discussionCard).toBeVisible({ timeout: 10_000 });
      await discussionCard.click();
      await expect(memberA.page.getByRole("heading", { name: he.waitlist.sheetTitle })).toBeVisible();
      for (const requester of requesters) {
        const name = requester === MEMBER1_ID ? SEEDED_USERS.member1.fullName : SEEDED_USERS.member2.fullName;
        await memberA.page.getByRole("checkbox", { name }).check();
      }
      // The sheet's own trigger and the nested `ConfirmDialog`'s confirm button share the exact
      // same accessible name, but only one is ever reachable by role at a time: once the
      // (modal) `ConfirmDialog` opens, Radix marks the Sheet's background content
      // `aria-hidden`, so this same locator re-resolves to the dialog's own button on the
      // second click instead of double-clicking the sheet's trigger.
      const confirmButton = memberA.page.getByRole("button", { name: he.waitlist.confirm, exact: true });
      await confirmButton.click();
      await expect(memberA.page.getByRole("button", { name: he.common.cancel, exact: true })).toBeVisible();
      const resolveResponsePromise = memberA.page.waitForResponse((r) => r.url().includes("/rpc/resolve_waitlist_group"));
      await confirmButton.click();
      const resolveResponse = await resolveResponsePromise;
      expect(resolveResponse.ok(), `resolve_waitlist_group failed: ${await resolveResponse.text()}`).toBe(true);
      await expect(memberA.page.getByRole("heading", { name: he.waitlist.sheetTitle })).toHaveCount(0);
    } finally {
      await memberA.context.close();
    }

    const { data: resolvedRequests } = await service.from("requests").select("id, status").in("id", requests!.map((r) => r.id));
    expect(resolvedRequests!.some((r) => r.status === "assigned")).toBe(true);
    expect(resolvedRequests!.every((r) => r.status !== "waitlisted")).toBe(true);
    const { data: resolvedGroup } = await service.from("waitlist_groups").select("status, ride_id").eq("id", group!.id).single();
    expect(resolvedGroup!.status).toBe("resolved");
    expect(resolvedGroup!.ride_id).toBeTruthy();
    const { data: ride } = await service.from("rides").select("car_id, driver_id").eq("id", resolvedGroup!.ride_id).single();
    expect(ride!.car_id).toBe(freeCarId);
    expect([MEMBER1_ID, MEMBER2_ID]).toContain(ride!.driver_id);

    // The block disappears once resolved — no open group left for the day.
    const { data: dayGroupsAfter } = await service.from("waitlist_groups").select("id").eq("department_id", NEVO_DEPARTMENT_ID)
      .eq("week_start", weekStart).eq("day", day).eq("status", "open");
    expect(dayGroupsAfter?.length ?? 0).toBe(0);
  });

  test("a non-participant sees a read-only hint for an open discussion block", async ({ browser }) => {
    const service = serviceRoleClient();
    const { weekStart, day } = uniqueFutureWeek(2);
    // Every seeded account is either a participant candidate (member1/member2) or has
    // department-wide manage rights (admin/sadran, `can_manage_week()`) — neither is a true
    // "ordinary bystander". Provision one throwaway approved member the same way
    // `handle_new_user()` documents (a `member_invites` row consumed on sign-up).
    const bystanderEmail = `e2e-bystander-${Date.now()}@nevo.local`;
    const bystanderPassword = "nevo-demo-1234";

    const { error: inviteError } = await service.from("member_invites").insert({
      // `phone` is required for `handle_new_user()` to fully onboard the profile — omitting it
      // leaves `profiles.phone` null, which `RequireOnboarded` (guards.tsx) redirects to
      // `/onboarding` for, same as a real incomplete signup.
      email: bystanderEmail, full_name: "E2E Bystander", phone: "+972500000099", department_id: NEVO_DEPARTMENT_ID, role: "member",
    });
    if (inviteError) throw inviteError;
    const { data: created, error: createUserError } = await service.auth.admin.createUser({
      email: bystanderEmail, password: bystanderPassword, email_confirm: true,
    });
    if (createUserError) throw createUserError;
    const bystanderId = created.user!.id;

    try {
      const { error: weekError } = await service.from("weeks").insert({
        department_id: NEVO_DEPARTMENT_ID, week_start: weekStart, phase: "open",
        open_at: `${weekStart}T00:00:00Z`, close_at: `${day}T00:00:00Z`, publish_at: `${day}T00:00:00Z`,
      });
      if (weekError) throw weekError;
      await leaveOneSharedCarFree(NEVO_DEPARTMENT_ID, day);
      const { error: requestsError } = await service.from("requests").insert([MEMBER1_ID, MEMBER2_ID].map((requesterId) => ({
        department_id: NEVO_DEPARTMENT_ID, week_start: weekStart, requester_id: requesterId, filed_by: requesterId,
        ride_type_id: RIDE_TYPE_ID, destination_text: "E2E waitlist group destination 2", trip_shape: "round_trip",
        depart_at: `${day}T07:00:00+02:00`, return_at: `${day}T09:00:00+02:00`, adults: 1, status: "submitted",
      })));
      if (requestsError) throw requestsError;

      await publishDay(NEVO_DEPARTMENT_ID, weekStart, day);

      const outsider = await newSignedInPage(browser, { email: bystanderEmail, password: bystanderPassword });
      try {
        await outsider.page.setViewportSize({ width: 390, height: 844 });
        await outsider.page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${weekStart}`);
        await outsider.page.getByRole("radio", { name: "ג", exact: true }).click();
        const discussionCard = outsider.page.getByRole("button", { name: /בדיון:/ });
        await expect(discussionCard).toBeVisible({ timeout: 10_000 });
        await discussionCard.click();
        await expect(outsider.page.getByText(he.waitlist.readOnlyHint)).toBeVisible();
        await expect(outsider.page.getByRole("checkbox")).toHaveCount(0);
      } finally {
        await outsider.context.close();
      }
    } finally {
      await service.from("department_members").delete().eq("profile_id", bystanderId);
      await service.from("profiles").delete().eq("id", bystanderId);
      await service.auth.admin.deleteUser(bystanderId);
      await service.from("member_invites").delete().eq("email", bystanderEmail);
    }
  });
});
