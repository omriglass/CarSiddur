import { describe, expect, it } from "vitest";

import { callLabel, createSlowCallTracker, type SlowCallReport } from "./slowCalls";

function harness(overrides: { minGapMs?: number; maxReports?: number } = {}) {
  let clock = 0;
  let pending: { fn: () => void; at: number } | null = null;
  const reports: SlowCallReport[] = [];
  const tracker = createSlowCallTracker({
    thresholdMs: 3000, quietMs: 10_000, minGapMs: overrides.minGapMs ?? 300_000, maxReports: overrides.maxReports ?? 6,
    now: () => clock,
    setTimer: (fn, ms) => { pending = { fn, at: clock + ms }; return pending; },
    clearTimer: () => { pending = null; },
    report: (r) => reports.push(r),
  });
  const advance = (ms: number) => {
    clock += ms;
    while (pending && pending.at <= clock) { const p = pending; pending = null; p.fn(); }
  };
  return { tracker, reports, advance };
}

describe("callLabel", () => {
  it("keeps names only", () => {
    expect(callLabel("https://x.supabase.co/rest/v1/rpc/week_board_rides")).toBe("rpc week_board_rides");
    expect(callLabel("https://x.supabase.co/rest/v1/requests?select=id&requester_id=eq.abc")).toBe("table requests");
    expect(callLabel("https://x.supabase.co/functions/v1/answer-proposal")).toBe("functions answer-proposal");
    expect(callLabel("https://x.supabase.co/auth/v1/token?grant_type=refresh_token")).toBe("auth");
  });

  it("never times the error report itself", () => {
    expect(callLabel("https://x.supabase.co/rest/v1/client_errors")).toBeNull();
  });
});

describe("slow call tracker", () => {
  it("reports once, after the page is quiet, naming the worst call", () => {
    const { tracker, reports, advance } = harness();
    const a = tracker.start("https://x/rest/v1/rpc/week_board_rides");
    const b = tracker.start("https://x/rest/v1/cars");
    advance(500); b(false);
    advance(5000); a(false);
    expect(reports).toHaveLength(0);
    advance(10_000);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.message).toBe("slow API: 1 of 2 calls over 3000 ms; worst rpc week_board_rides 5500 ms (1 in flight)");
  });

  it("says nothing when every call is fast", () => {
    const { tracker, reports, advance } = harness();
    tracker.start("https://x/rest/v1/cars")(false);
    advance(60_000);
    expect(reports).toHaveLength(0);
  });

  it("waits while calls are still in flight, so a hang gets no extra call", () => {
    const { tracker, reports, advance } = harness();
    const a = tracker.start("https://x/rest/v1/rpc/a");
    const stuck = tracker.start("https://x/rest/v1/rpc/b");
    advance(4000); a(true);
    advance(30_000);
    expect(reports).toHaveLength(0);
    stuck(false);
    advance(10_000);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.detail).toContain("rpc b 34000 ms");
    expect(reports[0]?.detail).toContain("rpc a 4000 ms (1 in flight, failed)");
  });

  it("sends at most one report per gap and a few per page", () => {
    const { tracker, reports, advance } = harness({ minGapMs: 300_000, maxReports: 2 });
    const slowOnce = () => { const end = tracker.start("https://x/rest/v1/rpc/a"); advance(4000); end(false); advance(10_000); };
    slowOnce();
    slowOnce(); // inside the gap: dropped
    expect(reports).toHaveLength(1);
    advance(300_000);
    slowOnce();
    advance(300_000);
    slowOnce(); // over the page limit
    expect(reports).toHaveLength(2);
  });

  it("drops a report that fails to send", () => {
    let calls = 0;
    let fire: (() => void) | null = null;
    const tracker = createSlowCallTracker({ thresholdMs: 0, quietMs: 1, now: () => 0, setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => undefined,
      report: () => { calls += 1; throw new Error("offline"); } });
    tracker.start("https://x/rest/v1/rpc/a")(false);
    (fire as unknown as () => void)();
    expect(calls).toBe(1);
  });
});
