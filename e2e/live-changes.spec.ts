import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { he } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, SUPABASE_ANON_KEY, SUPABASE_URL, serviceRoleClient } from "./helpers";

/**
 * Pilot fix round P4 (REQ §13.118; docs/TODO.md R8U1, R8U2). NOT RUN by the author (written, not executed).
 *  - R8U2: a host ride with a merge waiting for the guest's answer keeps its own sheet (driver, times); the sheet links to the proposal.
 *  - R8U1: the ride sheet replaces a volunteer driver in one step (no "remove first").
 */
const WEEK = "2042-02-02";
const HOST_MEMBER = "00000000-0000-0000-0000-000000000103";
const GUEST_MEMBER = "00000000-0000-0000-0000-000000000104";
const PLACE = "00000000-0000-0000-0000-000000000011";
const TYPE = "00000000-0000-0000-0000-000000000021";
const at = (time: string) => `${WEEK}T${time}:00+02:00`;
const boardUrl = `/sadran/${NEVO_DEPARTMENT_ID}/${WEEK}/board`;

async function ensureUnpublishedWeek(service: SupabaseClient): Promise<void> {
  const { data: existing } = await service.from("weeks").select("phase").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK).maybeSingle();
  if (existing) return;
  const before = (days: number) => new Date(Date.parse(`${WEEK}T00:00:00Z`) - days * 86400000).toISOString();
  const { error } = await service.from("weeks").insert({ department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, phase: "solving", open_at: before(7), close_at: before(3), publish_at: before(2) });
  if (error) throw error;
}

async function cleanup(service: SupabaseClient) {
  await service.from("proposals").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  const { data: rides } = await service.from("rides").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  if (rides?.length) await service.from("ride_requests").delete().in("ride_id", rides.map((ride) => ride.id));
  await service.from("rides").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  await service.from("notifications").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
}

async function sadranClient(): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email: SEEDED_USERS.sadran.email, password: SEEDED_USERS.sadran.password });
  if (error) throw error;
  return client;
}

async function homeAndCar(service: SupabaseClient) {
  const { data: department } = await service.from("departments").select("home_destination_id").eq("id", NEVO_DEPARTMENT_ID).single();
  const { data: cars } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active").limit(1);
  return { home: department!.home_destination_id as string, carId: cars![0]!.id as string };
}

test("a host ride with a merge waiting for an answer opens its own sheet with a link to the proposal (R8U2)", { tag: ["@board", "@proposals"] }, async ({ browser }) => {
  test.slow();
  const service = serviceRoleClient();
  await ensureUnpublishedWeek(service);
  await cleanup(service);
  const contexts: { close: () => Promise<void> }[] = [];
  try {
    const { home, carId } = await homeAndCar(service);
    const base = { department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, ride_type_id: TYPE, destination_id: PLACE };
    const { data: requests, error } = await service.from("requests").insert([
      { ...base, requester_id: HOST_MEMBER, filed_by: HOST_MEMBER, trip_shape: "round_trip", trip_type: "round_trip", depart_at: at("07:15"), return_at: at("10:00"), status: "assigned" },
      { ...base, requester_id: GUEST_MEMBER, filed_by: GUEST_MEMBER, trip_shape: "one_way_to", one_way_car_mode: "passenger", trip_type: "one_way", depart_at: at("07:00"), status: "submitted" },
    ]).select("id");
    if (error) throw error;
    const { data: ride, error: rideError } = await service.from("rides").insert({
      department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, car_id: carId, created_by: HOST_MEMBER, driver_id: HOST_MEMBER, origin_id: home, destination_id: home,
      status: "confirmed", starts_at: at("07:15"), ends_at: at("10:00"), blocked_until: at("10:30"),
    }).select("id").single();
    if (rideError) throw rideError;
    await service.from("ride_requests").insert({ ride_id: ride.id, request_id: requests![0]!.id, role: "driver", leg: "both", car_mode: "keep" });

    const sadranApi = await sadranClient();
    const created = await sadranApi.rpc("create_proposal", {
      p_request_id: requests![1]!.id, p_ride_id: ride.id, p_type: "merge", p_payload: { ride_id: ride.id, legs: [{ ride_id: ride.id, leg: "out" }] },
      p_reason_he: "e2e", p_party_profile_ids: [], p_created_via: "sadran",
    });
    expect(created.error).toBeNull();
    const sent = await sadranApi.rpc("send_proposal", { p_proposal_id: created.data, p_sent_via: [] });
    expect(sent.error).toBeNull();

    const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
    contexts.push(sadran.context);
    const page = sadran.page;
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.goto(boardUrl);

    // the pending merge is still drawn as one marked block; clicking it opens the RIDE (not only the proposal)
    const merged = page.locator('button[data-merged="true"]:visible');
    await expect(merged).toHaveCount(1);
    await merged.click();
    const pending = page.getByTestId("ride-pending-merge");
    await expect(pending).toBeVisible();
    await expect(page.getByText(he.sadranRideSheet.title)).toBeVisible();
    // the proposal stays one click away
    await pending.getByRole("button", { name: he.sadranRideSheet.pendingMergeOpen }).click();
    await expect(pending).not.toBeVisible();
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await cleanup(service);
  }
});

test("the ride sheet replaces a volunteer driver in one step (R8U1)", { tag: ["@board"] }, async ({ browser }) => {
  test.slow();
  const service = serviceRoleClient();
  await ensureUnpublishedWeek(service);
  await cleanup(service);
  const contexts: { close: () => Promise<void> }[] = [];
  try {
    const { home, carId } = await homeAndCar(service);
    const { data: request, error } = await service.from("requests").insert({
      department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, ride_type_id: TYPE, destination_id: PLACE, requester_id: GUEST_MEMBER, filed_by: GUEST_MEMBER,
      trip_shape: "round_trip", trip_type: "drop_off", depart_at: at("09:00"), return_at: at("12:00"), status: "waitlisted",
    }).select("id").single();
    if (error) throw error;
    const { data: ride, error: rideError } = await service.from("rides").insert({
      department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, car_id: carId, created_by: HOST_MEMBER, driver_id: null, needs_driver: true, origin_id: home, destination_id: home,
      status: "flagged", flag_reason: "NEEDS_DRIVER", is_pinned: true, pin_reason: "MISSING_DRIVER", starts_at: at("09:00"), ends_at: at("12:00"), blocked_until: at("12:30"),
    }).select("id").single();
    if (rideError) throw rideError;
    await service.from("ride_requests").insert({ ride_id: ride.id, request_id: request.id, role: "passenger", leg: "both", car_mode: "chauffeur" });

    const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
    contexts.push(sadran.context);
    const page = sadran.page;
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.goto(boardUrl);

    const pick = async (index: number, button: string) => {
      await page.locator(`button[data-ride-id="${ride.id}"]:visible`).click();
      const picker = page.getByTestId("ride-driver-picker");
      await expect(picker).toBeVisible();
      await picker.getByTestId("ride-driver-select").click();
      await page.getByRole("option").nth(index).click();
      await picker.getByTestId(button).click();
    };
    await pick(0, "ride-driver-assign");
    await expect.poll(async () => (await service.from("rides").select("driver_id").eq("id", ride.id).single()).data?.driver_id).not.toBeNull();
    const first = (await service.from("rides").select("driver_id").eq("id", ride.id).single()).data!.driver_id;

    // volunteer assigned: the sheet offers "remove" AND a replacement picker; replacing needs no remove first
    await page.locator(`button[data-ride-id="${ride.id}"]:visible`).click();
    await expect(page.getByTestId("ride-driver-unassign")).toBeVisible();
    await expect(page.getByText(he.rideDriver.replaceLabel)).toBeVisible();
    await page.keyboard.press("Escape");
    await pick(0, "ride-driver-assign");
    await expect.poll(async () => (await service.from("rides").select("driver_id,needs_driver").eq("id", ride.id).single()).data?.driver_id).not.toBe(first);
    expect((await service.from("rides").select("needs_driver").eq("id", ride.id).single()).data?.needs_driver).toBe(false);
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await cleanup(service);
  }
});
