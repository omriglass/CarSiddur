import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient, SUPABASE_ANON_KEY, SUPABASE_URL } from "./helpers";

/**
 * REQ item 149 — screens show other people's changes without a reload.
 *
 * Realtime path (D2): every screen first shows `html[data-live-sync="live"]` (all its private channels
 * SUBSCRIBED). Then a change made elsewhere must arrive within ~3 s AND through the broadcast: the
 * `changed` websocket frame is received before the screen's first week re-read (`/rpc/week_board_rides`),
 * and no version check (`/rpc/week_change_seqs`) runs in between — so it was not the fallback.
 * Negative: a change on an unpublished day reaches no member screen (no frame, no re-read, no check).
 * Fallback path (D1): with the websocket blocked the screen stays `polling`, and the 15 s version check
 * alone brings the change in.
 *
 * Fixture week: published for its Monday only; Wednesday stays unpublished (Sadran-only).
 * The writer is a second signed-in person: the Sadran through the same RPC the board uses
 * (`edit_ride`, a reservation), or, for the board-to-board case, the first Sadran tab itself.
 */
test.use({ actionTimeout: 15_000 });

const WEEK = "2041-03-03"; // a Sunday
const PUBLISHED_DAY = "2041-03-04"; // Monday — published
const UNPUBLISHED_DAY = "2041-03-06"; // Wednesday — not published
const SADRAN_ID = "00000000-0000-0000-0000-000000000102";

type Service = ReturnType<typeof serviceRoleClient>;

interface Probe {
  /** ms timestamps of received `changed` broadcast frames. */
  frames: number[];
  /** ms timestamps of `/rpc/week_change_seqs` requests. */
  checks: number[];
  /** ms timestamps of `/rpc/week_board_rides` requests. */
  reads: number[];
}

function probe(page: Page): Probe {
  const result: Probe = { frames: [], checks: [], reads: [] };
  page.on("websocket", (socket) => {
    socket.on("framereceived", (frame) => {
      const text = typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8");
      // realtime-js 2.x may use the binary serializer for broadcasts: match the topic and event text, not JSON keys.
      if (text.includes("changed") && /week:[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}:(public|sadran)/.test(text)) result.frames.push(Date.now());
    });
  });
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/rpc/week_change_seqs")) result.checks.push(Date.now());
    if (url.includes("/rpc/week_board_rides")) result.reads.push(Date.now());
  });
  return result;
}

function since(values: number[], from: number): number[] {
  return values.filter((value) => value >= from);
}

async function signedInClient(user: { email: string; password: string }): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword(user);
  if (error) throw error;
  return client;
}

/** The week exists and only its Monday is published (idempotent across runs: snapshots are immutable). */
async function ensureFixtureWeek(service: Service): Promise<void> {
  const { data: week, error } = await service.from("weeks").select("phase, published_days")
    .eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK).maybeSingle();
  if (error) throw error;
  if (!week) {
    const at = (daysBefore: number) => new Date(Date.parse(`${WEEK}T00:00:00Z`) - daysBefore * 86_400_000).toISOString();
    const { error: insertError } = await service.from("weeks").insert({ department_id: NEVO_DEPARTMENT_ID, week_start: WEEK,
      phase: "open", open_at: at(7), close_at: at(3), publish_at: at(2) });
    if (insertError) throw insertError;
  }
  const days = (week?.published_days as string[] | undefined) ?? [];
  if (!days.includes(PUBLISHED_DAY)) {
    const admin = await signedInClient(SEEDED_USERS.admin);
    const args = { p_department_id: NEVO_DEPARTMENT_ID, p_week_start: WEEK };
    const { data: fingerprint, error: fingerprintError } = await admin.rpc("publish_scores_fingerprint", args);
    if (fingerprintError) throw fingerprintError;
    const { error: publishError } = await admin.rpc("publish_siddur", { ...args, p_expected_fingerprint: fingerprint,
      p_profile_scores: [], p_policy_scores: [], p_days: [PUBLISHED_DAY] });
    if (publishError) throw publishError;
    await admin.auth.signOut();
  }
  if (days.includes(UNPUBLISHED_DAY)) throw new Error(`fixture week ${WEEK} has ${UNPUBLISHED_DAY} published`);
}

async function cleanup(service: Service): Promise<void> {
  const { data: rides } = await service.from("rides").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  if (rides?.length) await service.from("ride_requests").delete().in("ride_id", rides.map((ride) => ride.id));
  await service.from("held_notices").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  await service.from("rides").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
}

/** The `edit_ride` payload of a one-hour reservation (a ride with no request, driven by the Sadran). */
async function reservation(service: Service, day: string, hour: number): Promise<Record<string, unknown>> {
  const { data: department } = await service.from("departments").select("home_destination_id").eq("id", NEVO_DEPARTMENT_ID).single();
  const { data: car } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID)
    .eq("type", "shared").eq("status", "active").order("name").limit(1).single();
  const hh = String(hour).padStart(2, "0");
  return {
    department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, car_id: car!.id,
    starts_at: `${day}T${hh}:00:00+02:00`, ends_at: `${day}T${hh}:45:00+02:00`,
    origin_id: department!.home_destination_id, destination_id: department!.home_destination_id,
    driver_id: SADRAN_ID, served: [],
  };
}

async function createRide(writer: SupabaseClient, payload: Record<string, unknown>): Promise<string> {
  const { data, error } = await writer.rpc("edit_ride", { p_ride: payload });
  if (error) throw error;
  return data as string;
}

/** Same RPC, sent from inside a signed-in browser tab (the tab's own session, like the board's own call). */
async function createRideFromPage(page: Page, payload: Record<string, unknown>): Promise<string> {
  return page.evaluate(async ({ url, anon, body }) => {
    const key = Object.keys(window.localStorage).find((name) => name.endsWith("-auth-token"));
    const token = key ? (JSON.parse(window.localStorage.getItem(key) ?? "{}") as { access_token?: string }).access_token : undefined;
    const response = await fetch(`${url}/rest/v1/rpc/edit_ride`, {
      method: "POST",
      headers: { apikey: anon, Authorization: `Bearer ${token}`, "Content-Type": "application/json", "x-app-surface": "board" },
      body: JSON.stringify({ p_ride: body }),
    });
    if (!response.ok) throw new Error(`edit_ride ${response.status}: ${await response.text()}`);
    return (await response.json()) as string;
  }, { url: SUPABASE_URL, anon: SUPABASE_ANON_KEY, body: payload });
}

/** Shows one day of the grid (the siddur and the board open on the week's first day). */
async function showDay(page: Page, day: string): Promise<void> {
  const [, month, date] = day.split("-").map(Number);
  await page.getByRole("radio", { name: new RegExp(`\\s${date}\\.${month}$`) }).first().click();
}

async function waitLive(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-live-sync", "live", { timeout: 20_000 });
}

/** The screen re-read the week and the ride is in its data (the DOM check follows). */
function rideReadBack(page: Page, rideId: string, timeout: number) {
  return page.waitForResponse(async (response) => {
    if (!response.url().includes("/rpc/week_board_rides") || !response.ok()) return false;
    const rows = (await response.json().catch(() => [])) as { id: string }[];
    return rows.some((row) => row.id === rideId);
  }, { timeout });
}

/** Arrived through the broadcast: a frame before the first re-read, no version check in between. */
function expectViaBroadcast(seen: Probe, from: number): void {
  const frames = since(seen.frames, from);
  const reads = since(seen.reads, from);
  expect(frames.length, "a `changed` broadcast frame was received").toBeGreaterThan(0);
  expect(reads.length, "the screen re-read the week").toBeGreaterThan(0);
  const firstFrame = frames[0]!;
  const firstRead = reads[0]!;
  expect(firstFrame, "the broadcast arrived before the re-read").toBeLessThanOrEqual(firstRead);
  expect(since(seen.checks, from).filter((at) => at <= firstRead), "no version check before the re-read").toEqual([]);
}

test.describe("live updates through Realtime", { tag: ["@live-sync"] }, () => {
  let service: Service;
  let sadranWriter: SupabaseClient;

  test.beforeEach(async () => {
    service = serviceRoleClient();
    await ensureFixtureWeek(service);
    await cleanup(service);
    sadranWriter = await signedInClient(SEEDED_USERS.sadran);
  });

  test.afterEach(async () => {
    await sadranWriter.auth.signOut().catch(() => undefined);
    await cleanup(service);
  });

  test("a Sadran's change on a published day reaches the member's open siddur by broadcast within ~3 s", async ({ browser }) => {
    test.slow();
    const member = await newSignedInPage(browser, SEEDED_USERS.member1);
    try {
      const seen = probe(member.page);
      await member.page.setViewportSize({ width: 1440, height: 900 });
      await member.page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${WEEK}`);
      await showDay(member.page, PUBLISHED_DAY);
      await waitLive(member.page);
      await member.page.waitForTimeout(500); // let the mount's own reads settle

      const payload = await reservation(service, PUBLISHED_DAY, 10);
      const from = Date.now();
      const rideId = await createRide(sadranWriter, payload);
      // Safe to start waiting now: the re-read follows the 500 ms broadcast debounce.
      // Member screens then wait a random 0–3 s: allow 3.5 s plus round trips.
      await rideReadBack(member.page, rideId, 5_000);
      const arrivedIn = Date.now() - from;
      expect(arrivedIn, "within ~3 s plus the member jitter").toBeLessThan(5_000);
      await expect(member.page.locator(`[data-ride-id="${rideId}"]`).first()).toBeAttached();
      expectViaBroadcast(seen, from);
    } finally {
      await member.context.close();
    }
  });

  test("two Sadran screens on one board: a change made in one appears in the other by broadcast", async ({ browser }) => {
    test.slow();
    const first = await newSignedInPage(browser, SEEDED_USERS.sadran);
    const second = await newSignedInPage(browser, SEEDED_USERS.admin);
    try {
      // Registered before the board loads, so the board's own socket is observed from its first frame.
      const seen = probe(second.page);
      for (const tab of [first, second]) {
        await tab.page.setViewportSize({ width: 1440, height: 900 });
        await tab.page.goto(`/sadran/${NEVO_DEPARTMENT_ID}/${WEEK}/board`);
        await showDay(tab.page, UNPUBLISHED_DAY);
        await waitLive(tab.page);
      }
      await second.page.waitForTimeout(500);

      const from = Date.now();
      // An unpublished day: the Sadran topic carries every change of the week.
      const payload = await reservation(service, UNPUBLISHED_DAY, 9);
      const readBack = second.page.waitForResponse((response) => response.url().includes("/rpc/week_board_rides") && response.ok(), { timeout: 3_000 });
      const rideId = await createRideFromPage(first.page, payload);
      await readBack;
      expect(Date.now() - from, "Sadran screens have no jitter: within ~3 s").toBeLessThan(3_000);
      await expect(second.page.locator(`[data-ride-id="${rideId}"]`).first()).toBeAttached({ timeout: 3_000 });
      expectViaBroadcast(seen, from);
    } finally {
      await first.context.close();
      await second.context.close();
    }
  });

  test("a change on an unpublished day does not touch the member's open siddur", async ({ browser }) => {
    test.slow();
    const member = await newSignedInPage(browser, SEEDED_USERS.member1);
    try {
      await member.page.setViewportSize({ width: 1440, height: 900 });
      const seen = probe(member.page);
      await member.page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${WEEK}`);
      await showDay(member.page, PUBLISHED_DAY);
      await waitLive(member.page);
      await member.page.waitForTimeout(1_000);

      const from = Date.now();
      await createRide(sadranWriter, await reservation(service, UNPUBLISHED_DAY, 14));
      await member.page.waitForTimeout(5_000);
      expect(since(seen.frames, from), "no broadcast reaches a member for an unpublished day").toEqual([]);
      expect(since(seen.reads, from), "no re-read").toEqual([]);
      expect(since(seen.checks, from), "no version check within the 60 s live interval").toEqual([]);
      await expect(member.page.locator("html")).toHaveAttribute("data-live-sync", "live");
    } finally {
      await member.context.close();
    }
  });
});

test.describe("live updates without Realtime (version check fallback)", { tag: ["@live-sync"] }, () => {
  let service: Service;
  let sadranWriter: SupabaseClient;

  test.beforeEach(async () => {
    service = serviceRoleClient();
    await ensureFixtureWeek(service);
    await cleanup(service);
    sadranWriter = await signedInClient(SEEDED_USERS.sadran);
  });

  test.afterEach(async () => {
    await sadranWriter.auth.signOut().catch(() => undefined);
    await cleanup(service);
  });

  test("with the websocket blocked, the 15 s version check brings the change in", async ({ browser }) => {
    test.slow();
    const member = await newSignedInPage(browser, SEEDED_USERS.member1);
    try {
      // Every Realtime socket of the tab is refused (as a network that blocks websockets would).
      await member.page.routeWebSocket(/\/realtime\/v1\//, (socket) => socket.close({ code: 1008, reason: "blocked by test" }));
      const seen = probe(member.page);
      await member.page.setViewportSize({ width: 1440, height: 900 });
      await member.page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${WEEK}`);
      await showDay(member.page, PUBLISHED_DAY);
      await expect.poll(() => seen.checks.length, { timeout: 15_000 }).toBeGreaterThan(0);
      await expect(member.page.locator("html")).not.toHaveAttribute("data-live-sync", "live");

      const from = Date.now();
      const rideId = await createRide(sadranWriter, await reservation(service, PUBLISHED_DAY, 16));
      // ≤ 15 s to the next check + ≤ 3 s member jitter + round trips.
      await rideReadBack(member.page, rideId, 22_000);
      await expect(member.page.locator(`[data-ride-id="${rideId}"]`).first()).toBeAttached();
      const firstRead = since(seen.reads, from)[0]!;
      expect(since(seen.frames, from), "no broadcast could arrive").toEqual([]);
      expect(since(seen.checks, from).some((at) => at <= firstRead), "a version check found the change first").toBe(true);
    } finally {
      await member.context.close();
    }
  });
});
