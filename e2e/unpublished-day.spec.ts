import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { paths } from "../src/app/routes";
import { NEVO_DEPARTMENT_ID, getWeekStart, SEEDED_USERS, serviceRoleClient, signIn, SUPABASE_ANON_KEY, SUPABASE_URL } from "./helpers";

// REQ §13.155 (owner 2026-10-26): in a partly published week a day not published yet is stamped "טרם פורסם" all over —
// the siddur's day list on a phone, the whole table on a computer, its own column on /my's week view — and takes no
// member requests (`day_not_published`). A week nothing of which is published shows no stamp on /my.

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** A far-future week published on its Monday only (kept afterwards: a published week's history row is immutable). */
async function partlyPublishedWeek(): Promise<string> {
  const service = serviceRoleClient();
  const live = await getWeekStart("live");
  const week = addDays(live, 7 * 40);
  const { data: existing } = await service.from("weeks").select("phase").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week).maybeSingle();
  if (existing?.phase === "published") return week;
  if (!existing) {
    const { error } = await service.from("weeks").insert({ department_id: NEVO_DEPARTMENT_ID, week_start: week, phase: "solving",
      open_at: new Date(Date.now() - 3 * 86_400_000).toISOString(), close_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      publish_at: new Date(Date.now() - 86_400_000).toISOString() });
    if (error) throw error;
  }
  const sadran = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { error: authError } = await sadran.auth.signInWithPassword(SEEDED_USERS.sadran);
  if (authError) throw authError;
  const args = { p_department_id: NEVO_DEPARTMENT_ID, p_week_start: week };
  const { data: fingerprint, error: fpError } = await sadran.rpc("publish_scores_fingerprint", args);
  if (fpError) throw fpError;
  const { error } = await sadran.rpc("publish_siddur", { ...args, p_expected_fingerprint: fingerprint, p_profile_scores: [], p_policy_scores: [], p_days: [addDays(week, 1)] });
  if (error) throw error;
  return week;
}

test.describe("unpublished days of a partly published week", { tag: ["@siddur", "@my-week", "@request-form"] }, () => {
  let week: string;
  test.beforeAll(async () => { week = await partlyPublishedWeek(); });

  test("phone siddur: the unpublished day is stamped, the published day is not", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, SEEDED_USERS.member1);
    await page.goto(paths.siddur({ dept: NEVO_DEPARTMENT_ID, week, day: addDays(week, 2) }));
    const tuesday = page.getByText(`${Number(addDays(week, 2).slice(8))}.${Number(addDays(week, 2).slice(5, 7))}`, { exact: true }).locator("visible=true").first();
    await tuesday.click();
    await expect(page.getByTestId("draft-watermark").locator("visible=true")).toHaveCount(1);
    const monday = page.getByText(`${Number(addDays(week, 1).slice(8))}.${Number(addDays(week, 1).slice(5, 7))}`, { exact: true }).locator("visible=true").first();
    await monday.click();
    await expect(page.getByTestId("draft-watermark").locator("visible=true")).toHaveCount(0);
  });

  test("/my week view: every day but the published one carries the stamp; an open week none", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await signIn(page, SEEDED_USERS.member1);
    await page.goto(`${paths.my()}?view=week&week=${week}`);
    await expect(page.getByTestId("week-grid-car-name").first()).toBeVisible();
    await expect(page.locator("[data-unpublished]")).toHaveCount(6);
    await expect(page.getByTestId("draft-watermark")).toHaveCount(6);

    const open = await getWeekStart("open");
    await page.goto(`${paths.my()}?view=week&week=${open}`);
    await expect(page.getByTestId("week-grid-car-name").first()).toBeVisible();
    await expect(page.locator("[data-unpublished]")).toHaveCount(0);
  });

  test("the Sadran's empty-slot double-click on an unpublished day offers a request for that day and hours (R15M1)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await signIn(page, SEEDED_USERS.sadran);
    const day = addDays(week, 2);
    await page.goto(paths.sadran.board(NEVO_DEPARTMENT_ID, week));
    await page.getByText(`${Number(day.slice(8))}.${Number(day.slice(5, 7))}`, { exact: true }).locator("visible=true").first().click();
    const column = page.locator('[data-car-col-id]:not([data-car-col-id^="phantom:"]):visible').first();
    await column.scrollIntoViewIfNeeded();
    const box = await column.boundingBox();
    if (!box) throw new Error("car column not found");
    await column.dblclick({ position: { x: box.width / 2, y: Math.min(box.height - 10, 200) } });
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("reservation-new-request").click();
    await expect(page).toHaveURL(new RegExp(`/requests/new\\?.*week=${week}.*day=${day}`));
    // The form opens on that week with the slot's day picked (the classic layout's day radios read "ג 03").
    await expect(page.getByRole("radiogroup", { name: "יום" }).getByRole("radio", { checked: true })).toContainText(day.slice(8));
  });

  test("a member's request for the unpublished day is refused", async () => {
    const member = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { error: authError } = await member.auth.signInWithPassword(SEEDED_USERS.member1);
    if (authError) throw authError;
    const at = (day: string, time: string) => new Date(`${day}T${time}:00+02:00`).toISOString();
    const payload = { department_id: NEVO_DEPARTMENT_ID, week_start: week, destination_text: "E2E unpublished day", ride_type_id: "00000000-0000-0000-0000-000000000021",
      trip_type: "round_trip", adults: 1, depart_at: at(addDays(week, 2), "09:00"), return_at: at(addDays(week, 2), "12:00") };
    const { error } = await member.rpc("submit_request", { payload });
    expect(error?.message).toBe("day_not_published");
  });
});
