import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BROADCAST_DEBOUNCE_MS,
  ChangeWatcher,
  FALLBACK_POLL_MS,
  HIDDEN_DISCONNECT_MS,
  LIVE_POLL_MS,
  MEMBER_JITTER_MS,
  RETRY_BASE_MS,
  resetWatcherSession,
  type ChannelHandlers,
  type SeqRow,
  type WatchChange,
  type WatcherDeps,
  type WatchTarget,
} from "./watcher";

const DEPT = "dept-1";
const WEEK = "2026-11-01";

interface Harness {
  deps: WatcherDeps;
  fetchSeqs: ReturnType<typeof vi.fn>;
  invalidated: WatchChange[];
  channels: { week: string; handlers: ChannelHandlers; closed: boolean }[];
  setRows(rows: Partial<SeqRow>): void;
  setVisible(visible: boolean): void;
  reports: string[];
}

function harness(options: { realtime?: boolean; random?: number } = {}): Harness {
  let row: SeqRow = { weekStart: WEEK, seq: 1, publicSeq: 1, deptSeq: 1 };
  let visible = true;
  const invalidated: WatchChange[] = [];
  const channels: Harness["channels"] = [];
  const reports: string[] = [];
  const fetchSeqs = vi.fn(async () => [row]);
  const deps: WatcherDeps = {
    fetchSeqs,
    invalidate: (change) => invalidated.push(change),
    isVisible: () => visible,
    random: () => options.random ?? 0,
    reportRefusal: (detail) => reports.push(detail),
  };
  if (options.realtime !== false) {
    deps.subscribe = (_dept, week, _scope, handlers) => {
      const channel = { week, handlers, closed: false };
      channels.push(channel);
      return () => {
        channel.closed = true;
      };
    };
  }
  return {
    deps,
    fetchSeqs,
    invalidated,
    channels,
    reports,
    setRows: (patch) => {
      row = { ...row, ...patch };
    },
    setVisible: (value) => {
      visible = value;
    },
  };
}

function target(scope: WatchTarget["scope"], realtime = true): WatchTarget {
  return { departmentId: DEPT, weeks: [WEEK], scope, realtime };
}

function ch(h: Harness, index: number): Harness["channels"][number] {
  const channel = h.channels[index];
  if (!channel) throw new Error(`no channel ${index}`);
  return channel;
}

/** Lets the awaited fetch resolve. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetWatcherSession();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ChangeWatcher version check", () => {
  it("takes a baseline on start and invalidates nothing", async () => {
    const h = harness({ realtime: false });
    const watcher = new ChangeWatcher(target("sadran", false), h.deps);
    watcher.start();
    await flush();
    expect(h.fetchSeqs).toHaveBeenCalledTimes(1);
    expect(h.invalidated).toEqual([]);
    watcher.stop();
  });

  it("polls every 15 s without a live channel and invalidates the moved week", async () => {
    const h = harness({ realtime: false });
    const watcher = new ChangeWatcher(target("sadran", false), h.deps);
    watcher.start();
    await flush();
    expect(watcher.pollInterval()).toBe(FALLBACK_POLL_MS);
    h.setRows({ seq: 2 });
    await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS - 1);
    expect(h.fetchSeqs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchSeqs).toHaveBeenCalledTimes(2);
    expect(h.invalidated).toEqual([{ weeks: [WEEK], department: false }]);
    watcher.stop();
  });

  it("member scope watches public_seq only and waits a random 0-3 s", async () => {
    const h = harness({ realtime: false, random: 0.5 });
    const watcher = new ChangeWatcher(target("public", false), h.deps);
    watcher.start();
    await flush();
    h.setRows({ seq: 5 });
    await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS);
    expect(h.invalidated).toEqual([]);
    h.setRows({ publicSeq: 2 });
    await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS);
    expect(h.invalidated).toEqual([]);
    await vi.advanceTimersByTimeAsync(MEMBER_JITTER_MS * 0.5);
    expect(h.invalidated).toEqual([{ weeks: [WEEK], department: false }]);
    watcher.stop();
  });

  it("reports a department counter move separately", async () => {
    const h = harness({ realtime: false });
    const watcher = new ChangeWatcher(target("sadran", false), h.deps);
    watcher.start();
    await flush();
    h.setRows({ deptSeq: 2 });
    await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS);
    expect(h.invalidated).toEqual([{ weeks: [], department: true }]);
    watcher.stop();
  });

  it("a re-mounted screen compares with what the previous mount saw", async () => {
    const h = harness({ realtime: false });
    const first = new ChangeWatcher(target("sadran", false), h.deps);
    first.start();
    await flush();
    first.stop();
    h.setRows({ seq: 3 });
    const second = new ChangeWatcher(target("sadran", false), h.deps);
    second.start();
    await flush();
    expect(h.invalidated).toEqual([{ weeks: [WEEK], department: false }]);
    second.stop();
  });

  it("checks at once when the tab becomes visible and when the network comes back", async () => {
    const h = harness({ realtime: false });
    const watcher = new ChangeWatcher(target("sadran", false), h.deps);
    watcher.start();
    await flush();
    h.setVisible(false);
    watcher.setVisible(false);
    await vi.advanceTimersByTimeAsync(10 * FALLBACK_POLL_MS);
    expect(h.fetchSeqs).toHaveBeenCalledTimes(1);
    h.setVisible(true);
    watcher.setVisible(true);
    await flush();
    expect(h.fetchSeqs).toHaveBeenCalledTimes(2);
    watcher.online();
    await flush();
    expect(h.fetchSeqs).toHaveBeenCalledTimes(3);
    watcher.stop();
  });

  it("swallows a failed check and recovers on the next poll", async () => {
    const h = harness({ realtime: false });
    const watcher = new ChangeWatcher(target("sadran", false), h.deps);
    watcher.start();
    await flush();
    h.fetchSeqs.mockRejectedValueOnce(new Error("offline"));
    await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS);
    h.setRows({ seq: 9 });
    await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS);
    expect(h.invalidated).toEqual([{ weeks: [WEEK], department: false }]);
    watcher.stop();
  });
});

describe("ChangeWatcher live channels", () => {
  it("polls every 60 s while the channel is live, 15 s after it fails", async () => {
    const h = harness();
    const watcher = new ChangeWatcher(target("sadran"), h.deps);
    watcher.start();
    await flush();
    expect(h.channels).toHaveLength(1);
    expect(watcher.pollInterval()).toBe(FALLBACK_POLL_MS);
    ch(h, 0).handlers.onStatus("live");
    expect(watcher.pollInterval()).toBe(LIVE_POLL_MS);
    await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS * 3);
    expect(h.fetchSeqs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS - FALLBACK_POLL_MS * 3);
    expect(h.fetchSeqs).toHaveBeenCalledTimes(2);
    ch(h, 0).handlers.onStatus("failed", "CHANNEL_ERROR");
    expect(watcher.pollInterval()).toBe(FALLBACK_POLL_MS);
    expect(ch(h, 0).closed).toBe(true);
    await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS);
    expect(h.fetchSeqs).toHaveBeenCalledTimes(3);
    watcher.stop();
  });

  it("debounces broadcasts 500 ms into one invalidation (Sadran: no jitter)", async () => {
    const h = harness({ random: 0.9 });
    const watcher = new ChangeWatcher(target("sadran"), h.deps);
    watcher.start();
    await flush();
    ch(h, 0).handlers.onStatus("live");
    ch(h, 0).handlers.onChange(2);
    await vi.advanceTimersByTimeAsync(100);
    ch(h, 0).handlers.onChange(3);
    await vi.advanceTimersByTimeAsync(BROADCAST_DEBOUNCE_MS - 101);
    expect(h.invalidated).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.invalidated).toEqual([{ weeks: [WEEK], department: false }]);
    // The broadcast moved the baseline: the next poll (counter 3) does not invalidate again.
    h.setRows({ seq: 3 });
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
    expect(h.invalidated).toHaveLength(1);
    watcher.stop();
  });

  it("adds member jitter on top of the broadcast debounce", async () => {
    const h = harness({ random: 1 / 3 });
    const watcher = new ChangeWatcher(target("public"), h.deps);
    watcher.start();
    await flush();
    ch(h, 0).handlers.onStatus("live");
    ch(h, 0).handlers.onChange(2);
    await vi.advanceTimersByTimeAsync(BROADCAST_DEBOUNCE_MS + MEMBER_JITTER_MS / 3 - 1);
    expect(h.invalidated).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.invalidated).toHaveLength(1);
    watcher.stop();
  });

  it("closes channels 30 s after hidden, re-checks and re-subscribes on visible", async () => {
    const h = harness();
    const watcher = new ChangeWatcher(target("sadran"), h.deps);
    watcher.start();
    await flush();
    ch(h, 0).handlers.onStatus("live");
    h.setVisible(false);
    watcher.setVisible(false);
    await vi.advanceTimersByTimeAsync(HIDDEN_DISCONNECT_MS - 1);
    expect(ch(h, 0).closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(ch(h, 0).closed).toBe(true);
    expect(watcher.channelStatus(WEEK)).toBe("closed");
    h.setVisible(true);
    watcher.setVisible(true);
    await flush();
    expect(h.fetchSeqs).toHaveBeenCalledTimes(2);
    expect(h.channels).toHaveLength(2);
    expect(ch(h, 1).closed).toBe(false);
    watcher.stop();
    expect(ch(h, 1).closed).toBe(true);
  });

  it("a short hide keeps the channel", async () => {
    const h = harness();
    const watcher = new ChangeWatcher(target("sadran"), h.deps);
    watcher.start();
    await flush();
    ch(h, 0).handlers.onStatus("live");
    watcher.setVisible(false);
    await vi.advanceTimersByTimeAsync(HIDDEN_DISCONNECT_MS / 2);
    watcher.setVisible(true);
    await vi.advanceTimersByTimeAsync(HIDDEN_DISCONNECT_MS);
    expect(h.channels).toHaveLength(1);
    expect(ch(h, 0).closed).toBe(false);
    watcher.stop();
  });

  it("retries a refused channel with backoff, reports once, and checks after re-joining", async () => {
    const h = harness();
    const watcher = new ChangeWatcher(target("sadran"), h.deps);
    watcher.start();
    await flush();
    ch(h, 0).handlers.onStatus("failed", "429");
    expect(h.reports).toEqual(["429"]);
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    expect(h.channels).toHaveLength(2);
    ch(h, 1).handlers.onStatus("failed", "TIMED_OUT");
    expect(h.reports).toEqual(["429"]);
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 2 - 1);
    expect(h.channels).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.channels).toHaveLength(3);
    const before = h.fetchSeqs.mock.calls.length;
    ch(h, 2).handlers.onStatus("live");
    await flush();
    expect(h.fetchSeqs.mock.calls.length).toBe(before + 1);
    expect(watcher.pollInterval()).toBe(LIVE_POLL_MS);
    watcher.stop();
  });

  it("does not open channels when the screen may not (realtime: false)", async () => {
    const h = harness();
    const watcher = new ChangeWatcher(target("public", false), h.deps);
    watcher.start();
    await flush();
    expect(h.channels).toHaveLength(0);
    expect(watcher.pollInterval()).toBe(FALLBACK_POLL_MS);
    watcher.stop();
  });

  it("ignores events of a channel after stop", async () => {
    const h = harness();
    const watcher = new ChangeWatcher(target("sadran"), h.deps);
    watcher.start();
    await flush();
    const handlers = ch(h, 0).handlers;
    watcher.stop();
    handlers.onChange(5);
    await vi.advanceTimersByTimeAsync(BROADCAST_DEBOUNCE_MS * 2);
    expect(h.invalidated).toEqual([]);
  });
});
