import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Browser, type BrowserContext, type Page, type WebSocketRoute } from "@playwright/test";

import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient, SUPABASE_ANON_KEY, SUPABASE_URL } from "./helpers";

/**
 * REQ item 149 (g) — a screen is never stale after minutes of idling, without real waiting.
 *
 * Playwright's clock (`page.clock.install()` before the target navigation; `runFor` = every timer in
 * between fires, as for a screen left open; `fastForward` = one jump, as for a laptop that slept) turns
 * 3 / 6 / 12 idle minutes into seconds. The network is real: the change is made by the Sadran through
 * the same RPC the board uses (`edit_ride`, a reservation on a published day), from the test process.
 *
 * Each test runs a "no change" CONTROL phase first (idle N minutes, nothing happens: gated queries are
 * not re-read), then a CHANGE phase (a ride appears during the idle: what the person sees must show it).
 *
 * Variations: (1) tab visible, realtime connected; (2) tab hidden then shown (the 5-minute cap re-reads
 * even when the counter did not move); (3) realtime dropped during the idle (15 s check); (4) offline
 * then back online. Screens: member siddur, member /my, Sadran board (board: variations 1 and 2).
 *
 * `/my` list mode reads `my_upcoming_rides`, which is deliberately NOT counter-gated (ARCHITECTURE §12.1):
 * its control asserts that it still re-reads on return, and its change phase that the ride shows.
 */
test.use({ actionTimeout: 15_000 });

const WEEK = "2041-03-10"; // a Sunday, its own fixture week (live-sync.spec.ts uses 2041-03-03)
const PUBLISHED_DAY = "2041-03-11"; // Monday — published
const UNPUBLISHED_DAY = "2041-03-13"; // Wednesday — not published
const MEMBER1_ID = "00000000-0000-0000-0000-000000000103";
const RIDE_TIME = /10:00\s*[–-]\s*10:45/;
const MINUTE = 60_000;
const DURATIONS = [3, 6, 12] as const;
const CAP_MINUTES = 5;

type Service = ReturnType<typeof serviceRoleClient>;
type Screen = "siddur" | "my" | "board";

async function signedInClient(user: { email: string; password: string }): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword(user);
  if (error) throw error;
  return client;
}

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

/** A 10:00–10:45 reservation on the published day, driven by member 1 (so it is on /my too). */
async function createReservation(service: Service, writer: SupabaseClient): Promise<string> {
  const { data: department } = await service.from("departments").select("home_destination_id").eq("id", NEVO_DEPARTMENT_ID).single();
  const { data: car } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID)
    .eq("type", "shared").eq("status", "active").order("name").limit(1).single();
  const { data, error } = await writer.rpc("edit_ride", {
    p_ride: {
      department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, car_id: car!.id,
      starts_at: `${PUBLISHED_DAY}T10:00:00+02:00`, ends_at: `${PUBLISHED_DAY}T10:45:00+02:00`,
      origin_id: department!.home_destination_id, destination_id: department!.home_destination_id,
      driver_id: MEMBER1_ID, served: [],
    },
  });
  if (error) throw error;
  return data as string;
}

interface Requests {
  /** `week_board_rides` counts only the fixture week's reads. */
  count(name: "week_board_rides" | "my_upcoming_rides" | "week_change_seqs"): number;
}

function trackRequests(page: Page): Requests {
  const urls: string[] = [];
  // The siddur/board also read the CURRENT week (another key, no watcher for it: it keeps refetching on return),
  // so a week read counts only when it asks for the fixture week.
  page.on("request", (request) => {
    const url = request.url();
    if (!url.includes("/rpc/week_board_rides") || (request.postData() ?? "").includes(`"${WEEK}"`)) urls.push(url);
  });
  return { count: (name) => urls.filter((url) => url.includes(`/rpc/${name}`)).length };
}

async function showDay(page: Page, day: string): Promise<void> {
  const [, month, date] = day.split("-").map(Number);
  await page.getByRole("radio", { name: new RegExp(`\\s${date}\\.${month}$`) }).first().click();
}

/** The siddur / board hide a tab the way the browser does: `visibilityState` + the event (and `focus` on return). */
async function setVisibility(page: Page, state: "hidden" | "visible"): Promise<void> {
  await page.evaluate((next) => {
    const w = window as unknown as { __vis?: string };
    if (w.__vis === undefined) {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => w.__vis ?? "visible" });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => (w.__vis ?? "visible") === "hidden" });
    }
    w.__vis = next;
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
    if (next === "visible") window.dispatchEvent(new Event("focus"));
  }, state);
}

interface Opened {
  context: BrowserContext;
  page: Page;
  requests: Requests;
  /** Realtime sockets of the tab, so a test can drop them. */
  sockets: WebSocketRoute[];
  blockRealtime(): Promise<void>;
}

async function open(browser: Browser, screen: Screen): Promise<Opened> {
  const user = screen === "board" ? SEEDED_USERS.sadran : SEEDED_USERS.member1;
  const { context, page } = await newSignedInPage(browser, user);
  await page.setViewportSize({ width: 1440, height: 900 });
  const sockets: WebSocketRoute[] = [];
  let blocked = false;
  await page.routeWebSocket(/\/realtime\/v1\//, (socket) => {
    if (blocked) {
      void socket.close({ code: 1008, reason: "blocked by test" });
      return;
    }
    socket.connectToServer();
    sockets.push(socket);
  });
  const requests = trackRequests(page);
  await page.clock.install();
  if (screen === "siddur") {
    await page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${WEEK}`);
    await showDay(page, PUBLISHED_DAY);
  } else if (screen === "board") {
    await page.goto(`/sadran/${NEVO_DEPARTMENT_ID}/${WEEK}/board`);
    await showDay(page, PUBLISHED_DAY);
  } else {
    await page.goto("/my");
  }
  await expect(page.locator("html")).toHaveAttribute("data-live-sync", "live", { timeout: 20_000 });
  await page.waitForTimeout(1_000); // the mount's own reads settle
  return {
    context, page, requests, sockets,
    blockRealtime: async () => {
      blocked = true;
      await Promise.all(sockets.splice(0).map((socket) => socket.close({ code: 1006, reason: "dropped by test" })));
    },
  };
}

/** What the person sees: the ride card on the siddur / board, its time on /my. */
async function expectRideShown(page: Page, screen: Screen, rideId: string): Promise<void> {
  if (screen === "my") await expect(page.locator("body")).toContainText(RIDE_TIME, { timeout: 12_000 });
  else await expect(page.locator(`[data-ride-id="${rideId}"]`).first()).toBeAttached({ timeout: 12_000 });
}

async function expectRideNotShown(page: Page, screen: Screen): Promise<void> {
  if (screen === "my") await expect(page.locator("body")).not.toContainText(RIDE_TIME);
  else await expect(page.locator("[data-ride-id]")).toHaveCount(0);
}

/** The query family the control phase inspects: `/my` list mode has no counter-gated one. */
function gatedRead(screen: Screen): "week_board_rides" | "my_upcoming_rides" {
  return screen === "my" ? "my_upcoming_rides" : "week_board_rides";
}

/** After the jitter (≤ 3 s of page clock = real time, the clock keeps flowing) the screen has settled. */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(3_500);
}

type Variation = "visible" | "hidden" | "disconnected" | "offline";

const MATRIX: { variation: Variation; screens: Screen[]; durations: readonly number[] }[] = [
  { variation: "visible", screens: ["siddur", "my", "board"], durations: DURATIONS },
  { variation: "hidden", screens: ["siddur", "my", "board"], durations: DURATIONS },
  { variation: "disconnected", screens: ["siddur", "my"], durations: [3, 12] },
  { variation: "offline", screens: ["siddur", "my"], durations: [3, 12] },
];

test.describe("a screen left idle is never stale", { tag: ["@live-sync"] }, () => {
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

  for (const { variation, screens, durations } of MATRIX) {
    for (const screen of screens) {
      for (const minutes of durations) {
        test(`${variation}, ${minutes} min idle: ${screen}`, async ({ browser }) => {
          test.slow();
          const opened = await open(browser, screen);
          const { page, requests } = opened;
          const idleMs = minutes * MINUTE;
          const read = gatedRead(screen);
          /** Variation-specific idle; `during` runs in the middle (where the change happens). */
          async function idle(during?: () => Promise<void>): Promise<void> {
            if (variation === "visible") {
              await page.clock.runFor(idleMs / 2);
              await during?.();
              await page.clock.runFor(idleMs / 2);
            } else if (variation === "hidden") {
              await setVisibility(page, "hidden");
              await during?.();
              await page.clock.fastForward(idleMs);
              await setVisibility(page, "visible");
            } else if (variation === "disconnected") {
              await opened.blockRealtime();
              await page.clock.runFor(5_000); // the screen notices: 15 s polling from here on
              await during?.();
              await page.clock.runFor(idleMs);
            } else {
              await page.context().setOffline(true);
              await page.clock.runFor(idleMs / 2);
              await during?.();
              await page.clock.runFor(idleMs / 2);
              await page.context().setOffline(false);
            }
            await settle(page);
          }

          try {
            // CONTROL: nothing changes during the idle.
            const readsBefore = requests.count(read);
            const checksBefore = requests.count("week_change_seqs");
            await idle();
            const reads = requests.count(read) - readsBefore;
            const checks = requests.count("week_change_seqs") - checksBefore;
            test.info().annotations.push({ type: "control", description: `${read} re-reads: ${reads}, counter checks: ${checks}` });
            await expectRideNotShown(page, screen);
            if (variation === "visible" || variation === "disconnected") {
              expect(reads, "the counter did not move: no re-read of the week").toBe(0);
            } else if (variation === "hidden") {
              // Under the 5-minute cap a gated query waits for the counter; over it, or when ungated (/my), it re-reads.
              if (screen !== "my" && minutes < CAP_MINUTES) expect(reads, "counter unchanged and under the cap: no re-read").toBe(0);
              else expect(reads, "over the 5-minute cap (or ungated): re-read on return").toBeGreaterThan(0);
            }
            // offline: coming back online re-reads whatever is stale (React Query's reconnect refetch); only visibility is asserted.
            if (variation !== "visible") expect(checks, "the version check ran after the return").toBeGreaterThan(0);

            // CHANGE: a ride appears during the idle.
            let rideId = "";
            await idle(async () => {
              rideId = await createReservation(service, sadranWriter);
            });
            await expectRideShown(page, screen, rideId);
          } finally {
            await opened.context.close();
          }
        });
      }
    }
  }
});
