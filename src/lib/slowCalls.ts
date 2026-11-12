// PF1 (docs/PF1_PLAN_2026-11.md §11): a record of slow API calls, so a hang names its cause.
//
// Every database call the browser makes is timed. A call slower than the threshold is remembered, and once the
// page has been quiet for a while ONE summary goes to `client_errors` (context `perf:slow`): which calls, how
// long, how many were in flight. It must never make a slow moment slower, so:
//   - nothing is sent while any call is in flight - only after `quietMs` with none;
//   - at most one report per `minGapMs` and `maxReports` per page;
//   - the report itself (a `client_errors` insert) is never timed, and is never retried;
//   - only names are kept (`rpc week_board_rides`, `table requests`) - no query strings, no bodies.
export interface SlowCall {
  label: string;
  ms: number;
  /** Calls in flight when this one started, itself included. */
  inFlight: number;
  failed: boolean;
}

export interface SlowCallReport {
  message: string;
  detail: string;
}

export interface SlowCallOptions {
  thresholdMs?: number;
  quietMs?: number;
  minGapMs?: number;
  maxReports?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  report: (report: SlowCallReport) => void;
}

/** `rpc <name>` / `table <name>` / `auth` / `functions <name>`; null for calls that are never timed. */
export function callLabel(url: string): string | null {
  let path: string;
  try {
    path = new URL(url, "http://local").pathname;
  } catch {
    return null;
  }
  const rest = /\/rest\/v1\/(rpc\/)?([A-Za-z0-9_]+)/.exec(path);
  if (rest) return rest[2] === "client_errors" ? null : `${rest[1] ? "rpc" : "table"} ${rest[2]}`;
  const fn = /\/functions\/v1\/([A-Za-z0-9_-]+)/.exec(path);
  if (fn) return `functions ${fn[1]}`;
  if (path.includes("/auth/v1/")) return "auth";
  return null;
}

export function createSlowCallTracker(options: SlowCallOptions) {
  const thresholdMs = options.thresholdMs ?? 3000;
  const quietMs = options.quietMs ?? 10_000;
  const minGapMs = options.minGapMs ?? 5 * 60_000;
  const maxReports = options.maxReports ?? 6;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let inFlight = 0;
  let total = 0;
  let slow: SlowCall[] = [];
  let reports = 0;
  let lastReportAt = -Infinity;
  let timer: unknown = null;

  function flush(): void {
    timer = null;
    if (slow.length === 0) return;
    if (inFlight > 0) { arm(); return; } // still busy: wait for quiet, never add a call to a hang
    if (reports >= maxReports || now() - lastReportAt < minGapMs) { slow = []; total = 0; return; }
    const worst = [...slow].sort((a, b) => b.ms - a.ms || a.label.localeCompare(b.label));
    const first = worst[0];
    if (!first) return;
    const line = (c: SlowCall) => `${c.label} ${Math.round(c.ms)} ms (${c.inFlight} in flight${c.failed ? ", failed" : ""})`;
    const report = {
      message: `slow API: ${slow.length} of ${total} calls over ${thresholdMs} ms; worst ${line(first)}`,
      detail: worst.slice(0, 10).map(line).join("\n"),
    };
    slow = [];
    total = 0;
    reports += 1;
    lastReportAt = now();
    try { options.report(report); } catch { /* a failing report is dropped, never retried */ }
  }

  function arm(): void {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(flush, quietMs);
  }

  /** Call when a request starts; returns the function to call when it ends. */
  function start(url: string): (failed: boolean) => void {
    const label = callLabel(url);
    if (label === null) return () => undefined;
    inFlight += 1;
    total += 1;
    const startedAt = now();
    const concurrent = inFlight;
    let done = false;
    return (failed) => {
      if (done) return;
      done = true;
      inFlight -= 1;
      const ms = now() - startedAt;
      if (ms >= thresholdMs && slow.length < 50) slow.push({ label, ms, inFlight: concurrent, failed });
      if (slow.length > 0) arm();
      else if (inFlight === 0) total = 0;
    };
  }

  return { start };
}

/** Wraps `fetch` so every call is timed by `tracker`; the response and any error pass through untouched. */
export function timedFetch(tracker: ReturnType<typeof createSlowCallTracker>, inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const end = tracker.start(url);
    try {
      const response = await inner(input, init);
      end(!response.ok);
      return response;
    } catch (error) {
      end(true);
      throw error;
    }
  };
}
