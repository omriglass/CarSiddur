import { expect, test } from "@playwright/test";
import { he } from "../src/i18n/he";
import { newSignedInPage, NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Pilot fix round P2, R8B12 (REQ §13.117): on the board, changing the trip type of an UNMET request to a
 * drop-off places it on a free car (no longer stays on the unmet list), and the toast says it was placed.
 * NOT RUN by the author (written, not executed; the lead runs the suite).
 */
const WEEK = "2042-02-02";
const MEMBER = "00000000-0000-0000-0000-000000000103";
const PLACE = "00000000-0000-0000-0000-000000000011";
const at = (time: string) => `${WEEK}T${time}:00+02:00`;
const boardUrl = `/sadran/${NEVO_DEPARTMENT_ID}/${WEEK}/board`;

async function ensureUnpublishedWeek(service: SupabaseClient): Promise<void> {
  const { data: existing } = await service.from("weeks").select("phase").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK).maybeSingle();
  if (!existing) {
    const before = (days: number) => new Date(Date.parse(`${WEEK}T00:00:00Z`) - days * 86400000).toISOString();
    const { error } = await service.from("weeks").insert({ department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, phase: "solving", open_at: before(7), close_at: before(3), publish_at: before(2) });
    if (error) throw error;
  } else if (existing.phase !== "solving" && existing.phase !== "open") {
    await service.from("weeks").update({ phase: "solving" }).eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  }
}

async function cleanup(service: SupabaseClient) {
  const { data: rides } = await service.from("rides").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  if (rides?.length) await service.from("ride_requests").delete().in("ride_id", rides.map((ride) => ride.id));
  await service.from("rides").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  await service.from("notifications").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
}

test("changing an unmet request to a drop-off places it on a free car", { tag: ["@board"] }, async ({ browser }) => {
  const service = serviceRoleClient();
  await ensureUnpublishedWeek(service);
  await cleanup(service);
  const contexts: { close: () => Promise<void> }[] = [];
  try {
    const { data: department } = await service.from("departments").select("home_destination_id").eq("id", NEVO_DEPARTMENT_ID).single();
    const { data: request, error } = await service.from("requests").insert({
      department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, requester_id: MEMBER, filed_by: MEMBER, origin_id: department!.home_destination_id,
      ride_type_id: "00000000-0000-0000-0000-000000000021", destination_id: PLACE, trip_shape: "round_trip", trip_type: "round_trip",
      depart_at: at("08:00"), return_at: at("12:00"), status: "submitted",
    }).select("id").single();
    if (error) throw error;

    const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
    contexts.push(sadran.context);
    const page = sadran.page;
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.goto(boardUrl);
    const control = page.locator(`[data-testid="trip-type-change"][data-trip-request-id="${request.id}"]:visible`);
    await control.getByTestId("trip-type-select").click();
    await page.getByTestId("trip-type-option-drop_off").click();
    await page.getByRole("dialog").getByRole("button", { name: he.tripTypeChange.confirm, exact: true }).click();

    await expect.poll(async () => (await service.from("requests").select("trip_type").eq("id", request.id).single()).data?.trip_type).toBe("drop_off");
    await expect.poll(async () => {
      const { data } = await service.from("ride_requests").select("rides!inner(status)").eq("request_id", request.id);
      return (data ?? []).filter((row) => (row.rides as unknown as { status: string }).status !== "cancelled").length;
    }).toBeGreaterThan(0);
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await cleanup(service);
  }
});
