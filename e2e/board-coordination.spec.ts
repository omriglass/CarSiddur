import { expect, test, type Page } from "@playwright/test";
import { he } from "../src/i18n/he";
import { newSignedInPage, NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Ensures the fixture week exists but is **not yet public** (docs/TODO.md "Flaky /
 * time-dependent e2e specs", diagnosed 2026-09-14): this spec used to build its fixture with
 * `publishedFixtureWeek()`, which publishes the *entire* week up front, then dragged a request
 * onto a ride to create a Sadran-composed (`created_via: 'sadran'`) merge proposal on that same
 * now-public day — exactly what `20260910098000_reject_proposals_on_published_day.sql`'s
 * `proposal_day_public` guard forbids (the only exemption is `ask_to_join`). The board itself
 * needs no publication at all: every board/drag/edit action here goes through `can_manage_week()`
 * (the Sadran), which bypasses `is_day_public()` entirely, and `/publish`'s own readiness
 * preview is meant to be visited *before* publishing. So this fixture stays `solving` for the
 * whole test — publication was never actually required.
 */
async function ensureUnpublishedWeek(service: SupabaseClient, week: string): Promise<void> {
  const { data: existing } = await service.from("weeks").select("phase").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week).maybeSingle();
  if (!existing) {
    const at = (daysBefore: number) => new Date(Date.parse(`${week}T00:00:00Z`) - daysBefore * 86400000).toISOString();
    const { error } = await service.from("weeks").insert({ department_id: NEVO_DEPARTMENT_ID, week_start: week, phase: "solving", open_at: at(7), close_at: at(3), publish_at: at(2) });
    if (error) throw error;
  } else if (existing.phase !== "solving" && existing.phase !== "open") {
    // A local rerun with E2E_SKIP_RESET=1 may have left this week further along than "solving"
    // from a previous pass — force it back so the merge-proposal step below is never blocked.
    const { error } = await service.from("weeks").update({ phase: "solving" }).eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    if (error) throw error;
  }
}

async function dragRequest(page: Page, requestId: string, carId: string, minutes: number) {
  const grip = page.locator(`[data-request-id="${requestId}"]:visible`).getByRole("button", { name: he.sadranBoard.dragHandleLabel });
  await grip.scrollIntoViewIfNeeded();
  const column = page.locator(`[data-car-col-id="${carId}"]`);
  await column.evaluate((el, minute) => {
    const scroller = el.closest<HTMLElement>(".overflow-auto")!;
    scroller.scrollTop = Math.max(0, (minute - 360) / 1080 * el.scrollHeight - scroller.clientHeight / 2);
  }, minutes);
  const source = await grip.boundingBox();
  const target = await column.boundingBox();
  if (!source || !target) throw new Error("missing drag source/target");
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + (minutes - 360) / 1080 * target.height, { steps: 12 });
  await expect(page.locator("[data-drag-preview]")).toBeVisible();
  await page.mouse.up();
}

test("one-way drop persists a missing-driver ride, tight edits remain publishable, and merge awaits consent", async ({ browser }) => {
  // docs/TODO.md "Flaky / time-dependent e2e specs" (found 2026-09-11): this is the longest
  // single test in the suite (fixture setup + two drag/edit rounds + a publish-page visit + a
  // proposal send) and was timing out under the global 60 s budget even on the pre-refactor
  // commit — not a regression. Give it 3x headroom before deciding it's a real app bug.
  test.slow();
  const service = serviceRoleClient();
  const week = "2042-01-05";
  const members = ["00000000-0000-0000-0000-000000000103", "00000000-0000-0000-0000-000000000104"];
  const { data: department } = await service.from("departments").select("home_destination_id").eq("id", NEVO_DEPARTMENT_ID).single();
  const { data: cars } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active").limit(2);
  const { data: settings } = await service.from("department_settings").select("chauffeur_dwell_minutes").eq("department_id", NEVO_DEPARTMENT_ID).single();
  await ensureUnpublishedWeek(service, week);
  const contexts: { close: () => Promise<void> }[] = [];
  const at = (time: string) => `${week}T${time}:00+02:00`;
  const boardUrl = `/sadran/${NEVO_DEPARTMENT_ID}/${week}/board`;
  async function cleanupFixture() {
    await service.from("proposals").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    const { data: cleanup } = await service.from("rides").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    if (cleanup?.length) await service.from("ride_requests").delete().in("ride_id", cleanup.map((ride) => ride.id));
    await service.from("rides").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    await service.from("notifications").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
  }
  await cleanupFixture();
  try {
    const { data: requests, error: requestError } = await service.from("requests").insert([
      { department_id: NEVO_DEPARTMENT_ID, week_start: week, requester_id: members[0], filed_by: members[0], ride_type_id: "00000000-0000-0000-0000-000000000021", destination_id: "00000000-0000-0000-0000-000000000011", trip_shape: "round_trip", depart_at: at("07:15"), return_at: at("10:00"), status: "assigned" },
      { department_id: NEVO_DEPARTMENT_ID, week_start: week, requester_id: members[1], filed_by: members[1], ride_type_id: "00000000-0000-0000-0000-000000000021", destination_id: "00000000-0000-0000-0000-000000000011", trip_shape: "one_way_to", one_way_car_mode: "passenger", depart_at: at("07:00"), status: "submitted" },
      { department_id: NEVO_DEPARTMENT_ID, week_start: week, requester_id: members[1], filed_by: members[1], ride_type_id: "00000000-0000-0000-0000-000000000021", destination_id: "00000000-0000-0000-0000-000000000011", trip_shape: "one_way_to", one_way_car_mode: "relay", depart_at: at("12:00"), status: "submitted" },
    ]).select("id");
    if (requestError) throw requestError;
    const rideBase = { department_id: NEVO_DEPARTMENT_ID, week_start: week, car_id: cars![0]!.id, created_by: members[0], origin_id: department!.home_destination_id, destination_id: department!.home_destination_id, status: "confirmed" };
    const { data: rides, error: rideError } = await service.from("rides").insert([
      { ...rideBase, driver_id: members[0], starts_at: at("07:15"), ends_at: at("10:00"), blocked_until: at("10:30") },
      { ...rideBase, driver_id: null, starts_at: at("10:30"), ends_at: at("11:00"), blocked_until: at("11:30"), notes: "E2E tight reservation" },
    ]).select("id");
    if (rideError) throw rideError;
    const { error: linkError } = await service.from("ride_requests").insert({ ride_id: rides![0]!.id, request_id: requests![0]!.id, role: "driver", leg: "both", car_mode: "keep" });
    if (linkError) throw linkError;
    const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
    contexts.push(sadran.context);
    const page = sadran.page;
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.goto(boardUrl);
    await dragRequest(page, requests![2]!.id, cars![1]!.id, 720);
    await expect(page.locator('button[data-needs-driver="true"]:visible')).toHaveCount(1);
    const { data: standalone } = await service.from("rides").select("id,driver_id,needs_driver,starts_at,ends_at").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week).eq("needs_driver", true).single();
    expect(standalone!.driver_id).toBeNull();
    expect(Date.parse(standalone!.ends_at) - Date.parse(standalone!.starts_at)).toBe(Math.ceil((40 + settings!.chauffeur_dwell_minutes) / 15) * 15 * 60000);

    await page.locator(`button[data-ride-id="${rides![1]!.id}"]:visible`).click();
    await page.getByRole("dialog").getByLabel(he.sadranRideSheet.depart, { exact: true }).fill("10:00");
    await page.getByRole("dialog").getByRole("button", { name: he.sadranRideSheet.save, exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.locator('button[data-tight-schedule="true"]:visible')).toHaveCount(2);
    const { data: tight } = await service.from("rides").select("turnaround_override_minutes,blocked_until").eq("id", rides![0]!.id).single();
    expect(tight!.turnaround_override_minutes).toBe(0);
    expect(Date.parse(tight!.blocked_until)).toBe(Date.parse(at("10:00")));
    await page.goto(`/sadran/${NEVO_DEPARTMENT_ID}/${week}/publish`);
    await expect(page.getByText(he.boardCoordination.missingDriverPublish)).toBeVisible();
    await expect(page.getByRole("button", { name: he.publicationFlow.allYes, exact: true })).toBeEnabled();

    await page.goto(boardUrl);
    await dragRequest(page, requests![1]!.id, cars![0]!.id, 450);
    await expect(page.getByRole("heading", { name: he.boardCoordination.mergeTitle })).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText("07:00–10:00");
    await page.getByRole("button", { name: he.sadranBoard.prepareMerge }).click();
    await page.getByRole("button", { name: he.action.propose, exact: true }).click();
    await expect(page).toHaveURL(boardUrl);
    const ghost = page.locator('button[data-ride-id^="merge:"]:visible');
    await expect(ghost).toBeVisible();
    await expect(ghost).toContainText(SEEDED_USERS.member1.fullName.split(" ")[0]!);
    await expect(ghost).toContainText(SEEDED_USERS.member2.fullName);
    await expect(page.locator(`button[data-ride-id="${rides![0]!.id}"]:visible`)).toHaveClass(/opacity-50/);
    const { data: unchanged } = await service.from("rides").select("starts_at").eq("id", rides![0]!.id).single();
    expect(Date.parse(unchanged!.starts_at)).toBe(Date.parse(at("07:15")));
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await cleanupFixture();
  }
});
