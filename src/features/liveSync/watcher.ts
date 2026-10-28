/**
 * Change watch state machine (REQ item 149, ARCHITECTURE.md §12.1 "Change counters and live updates").
 *
 * Correctness comes from the version check alone: `week_change_seqs` is read on start, when the tab
 * becomes visible, when the network comes back, and on a timer while visible — every 60 s while every
 * live channel is joined, every 15 s otherwise (no channel, refused, failed, timed out, closed). When a
 * counter moved, the screen's lean set of queries is invalidated. Live channels (Realtime broadcast,
 * one per watched week) only lower the latency: a broadcast is debounced 500 ms and invalidates the
 * same set — except the broadcast of this page's own change (O28-8): it waits `OWN_CHANGE_GRACE_MS` (the broadcast
 * often arrives before the call's own response) and reloads only if the page did not refetch that week itself. Member screens add a random 0–3 s before invalidating, so a publish does not make every
 * open phone re-read at the same instant. 30 s after the tab is hidden, its channels are closed (a
 * forgotten tab does not hold one of the plan's 200 connections); on visible the check runs at once
 * and the channels reopen. A refused/failed channel retries with exponential backoff (5 s → 5 min).
 *
 * No React, no Supabase: everything external comes in through `WatcherDeps`, so the timings are
 * unit-tested with fake timers (`watcher.test.ts`).
 */

export type WatchScope = "public" | "sadran";

export interface SeqRow {
  weekStart: string;
  seq: number;
  publicSeq: number;
  deptSeq: number;
}

export type ChannelStatus = "live" | "failed";

export interface ChannelHandlers {
  /** A broadcast arrived: the topic's counter is now `seq`; `tab` = the page that made the change (O28-8). */
  onChange(seq: number | null, tab?: string | null): void;
  /** Joined, or refused / errored / timed out / closed by the server. */
  onStatus(status: ChannelStatus, detail?: string): void;
}

export interface WatchChange {
  weeks: string[];
  department: boolean;
}

export interface WatcherDeps {
  fetchSeqs(departmentId: string, weeks: readonly string[]): Promise<SeqRow[]>;
  /** Opens one live channel for a week; returns its close function. Absent = version check only. */
  subscribe?(departmentId: string, weekStart: string, scope: WatchScope, handlers: ChannelHandlers): () => void;
  invalidate(change: WatchChange): void;
  /** O28-8: was this broadcast's change made by this page (`lib/tabId.ts`)? */
  isOwnTab?(tab: string | null): boolean;
  /** O28-8: has this page refetched the week after its own change (`lib/ownRefresh.ts`)? Then its broadcast reloads nothing. */
  ownChangeRefreshed?(week: string): boolean;
  isVisible(): boolean;
  random(): number;
  /** Called at most once per page session for a refused/failed channel (the caller reports it). */
  reportRefusal?(detail: string): void;
  /** Every live channel of the screen joined (true) or not (false); for the test hook / diagnostics. */
  onLiveState?(live: boolean): void;
}

export interface WatchTarget {
  departmentId: string;
  weeks: readonly string[];
  scope: WatchScope;
  /** May this screen open live channels (the caller is a member/Sadran of the department)? */
  realtime: boolean;
}

export const LIVE_POLL_MS = 60_000;
export const FALLBACK_POLL_MS = 15_000;
export const HIDDEN_DISCONNECT_MS = 30_000;
export const BROADCAST_DEBOUNCE_MS = 500;
export const OWN_CHANGE_GRACE_MS = 3_000;
export const MEMBER_JITTER_MS = 3_000;
export const RETRY_BASE_MS = 5_000;
export const RETRY_MAX_MS = 5 * 60_000;

type Timer = ReturnType<typeof setTimeout>;

interface Channel {
  close: (() => void) | null;
  status: "connecting" | "live" | "failed" | "closed";
  attempts: number;
  retry: Timer | null;
  /** Was this channel ever live and then lost (a re-join must check for what was missed)? */
  wasDown: boolean;
}

/**
 * Last counter values seen per (department, week, scope) and per department, for the whole page
 * session: a screen that re-mounts compares against what the previous mount saw instead of
 * re-taking a baseline (which would hide a change made in between).
 */
const baselines = new Map<string, number>();
let refusalReported = false;

/** Tests only. */
export function resetWatcherSession(): void {
  baselines.clear();
  refusalReported = false;
}

function weekKey(target: WatchTarget, week: string): string {
  return `${target.departmentId}|${week}|${target.scope}`;
}

function deptKey(target: WatchTarget): string {
  return `${target.departmentId}|dept`;
}

export class ChangeWatcher {
  private readonly channels = new Map<string, Channel>();
  private pollTimer: Timer | null = null;
  private hiddenTimer: Timer | null = null;
  private invalidateTimer: Timer | null = null;
  private readonly ownChangeTimers = new Set<Timer>();
  private pendingWeeks = new Set<string>();
  private pendingDepartment = false;
  private checking = false;
  private recheck = false;
  private stopped = false;
  private lastLive: boolean | null = null;

  constructor(
    private readonly target: WatchTarget,
    private readonly deps: WatcherDeps,
  ) {}

  start(): void {
    if (this.target.weeks.length === 0) return;
    if (this.deps.isVisible()) {
      void this.check();
      this.connectAll();
    }
    this.schedulePoll();
  }

  stop(): void {
    this.stopped = true;
    this.clear("pollTimer");
    this.clear("hiddenTimer");
    this.clear("invalidateTimer");
    for (const timer of this.ownChangeTimers) clearTimeout(timer);
    this.ownChangeTimers.clear();
    for (const channel of this.channels.values()) this.closeChannel(channel);
    this.channels.clear();
    this.emitLive();
  }

  setVisible(visible: boolean): void {
    if (this.stopped || this.target.weeks.length === 0) return;
    if (visible) {
      this.clear("hiddenTimer");
      void this.check();
      this.connectAll();
      this.schedulePoll();
      return;
    }
    this.clear("pollTimer");
    if (!this.hiddenTimer) {
      this.hiddenTimer = setTimeout(() => {
        this.hiddenTimer = null;
        for (const channel of this.channels.values()) {
          this.closeChannel(channel);
          channel.status = "closed";
          channel.attempts = 0;
        }
        this.emitLive();
      }, HIDDEN_DISCONNECT_MS);
    }
  }

  /** The browser came back online: check now and retry failed channels without waiting for their backoff. */
  online(): void {
    if (this.stopped || !this.deps.isVisible()) return;
    void this.check();
    for (const [week, channel] of this.channels) {
      if (channel.status === "failed") {
        channel.attempts = 0;
        this.clearRetry(channel);
        this.connect(week);
      }
    }
  }

  /** Current poll interval: 60 s with every channel live, else 15 s. */
  pollInterval(): number {
    return this.allLive() ? LIVE_POLL_MS : FALLBACK_POLL_MS;
  }

  channelStatus(week: string): Channel["status"] | undefined {
    return this.channels.get(week)?.status;
  }

  async check(): Promise<void> {
    if (this.stopped) return;
    if (this.checking) {
      this.recheck = true;
      return;
    }
    this.checking = true;
    try {
      const rows = await this.deps.fetchSeqs(this.target.departmentId, this.target.weeks);
      if (this.stopped) return;
      const weeks: string[] = [];
      let department = false;
      for (const row of rows) {
        const value = this.target.scope === "sadran" ? row.seq : row.publicSeq;
        if (this.observe(weekKey(this.target, row.weekStart), value)) weeks.push(row.weekStart);
        if (this.observe(deptKey(this.target), row.deptSeq)) department = true;
      }
      if (weeks.length > 0 || department) this.queueInvalidate(weeks, department, 0);
    } catch {
      // Silent: the next check, the focus refetch or a broadcast catches up.
    } finally {
      this.checking = false;
      if (this.recheck && !this.stopped) {
        this.recheck = false;
        void this.check();
      }
    }
  }

  /** Records a counter value; true when it moved past what this page session had seen. */
  private observe(key: string, value: number): boolean {
    const previous = baselines.get(key);
    if (previous === undefined || value > previous) baselines.set(key, value);
    return previous !== undefined && value > previous;
  }

  private queueInvalidate(weeks: string[], department: boolean, baseDelay: number): void {
    for (const week of weeks) this.pendingWeeks.add(week);
    this.pendingDepartment ||= department;
    if (this.invalidateTimer) return;
    const jitter = this.target.scope === "public" ? Math.floor(this.deps.random() * MEMBER_JITTER_MS) : 0;
    const delay = baseDelay + jitter;
    if (delay === 0) {
      this.runInvalidate();
      return;
    }
    this.invalidateTimer = setTimeout(() => {
      this.invalidateTimer = null;
      this.runInvalidate();
    }, delay);
  }

  private runInvalidate(): void {
    const change = { weeks: [...this.pendingWeeks], department: this.pendingDepartment };
    this.pendingWeeks = new Set();
    this.pendingDepartment = false;
    if (!this.stopped) this.deps.invalidate(change);
  }

  private allLive(): boolean {
    if (!this.target.realtime || !this.deps.subscribe) return false;
    return this.target.weeks.every((week) => this.channels.get(week)?.status === "live");
  }

  private schedulePoll(): void {
    this.clear("pollTimer");
    if (this.stopped || !this.deps.isVisible()) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.check();
      this.schedulePoll();
    }, this.pollInterval());
  }

  private connectAll(): void {
    if (!this.target.realtime || !this.deps.subscribe) return;
    for (const week of this.target.weeks) {
      const channel = this.channels.get(week);
      if (!channel || channel.status === "closed" || (channel.status === "failed" && !channel.retry)) this.connect(week);
    }
  }

  private connect(week: string): void {
    const subscribe = this.deps.subscribe;
    if (!subscribe || this.stopped) return;
    const existing = this.channels.get(week);
    const channel: Channel = existing ?? { close: null, status: "connecting", attempts: 0, retry: null, wasDown: false };
    this.closeChannel(channel);
    channel.status = "connecting";
    this.channels.set(week, channel);
    let current = true;
    channel.close = subscribe(this.target.departmentId, week, this.target.scope, {
      onChange: (seq, tab) => {
        if (!current || this.stopped) return;
        if (seq !== null) this.observe(weekKey(this.target, week), seq);
        if (this.deps.isOwnTab?.(tab ?? null) && this.deps.ownChangeRefreshed) {
          this.awaitOwnRefresh(week);
          return;
        }
        this.queueInvalidate([week], false, BROADCAST_DEBOUNCE_MS);
      },
      onStatus: (status, detail) => {
        if (!current || this.stopped || channel.status === "closed") return;
        const before = this.pollInterval();
        if (status === "live") {
          channel.status = "live";
          channel.attempts = 0;
          if (channel.wasDown) void this.check();
          channel.wasDown = false;
        } else {
          current = false;
          channel.status = "failed";
          channel.wasDown = true;
          this.closeChannel(channel);
          this.reportOnce(detail ?? "failed");
          this.scheduleRetry(week, channel);
        }
        if (this.pollInterval() !== before) this.schedulePoll();
        this.emitLive();
      },
    });
    const close = channel.close;
    channel.close = () => {
      current = false;
      close?.();
    };
  }

  /** O28-8: this page's own change — reload only if the page has not refetched the week itself by the end of the grace period. */
  private awaitOwnRefresh(week: string): void {
    const timer = setTimeout(() => {
      this.ownChangeTimers.delete(timer);
      if (this.stopped || this.deps.ownChangeRefreshed?.(week)) return;
      this.queueInvalidate([week], false, 0);
    }, OWN_CHANGE_GRACE_MS);
    this.ownChangeTimers.add(timer);
  }

  private emitLive(): void {
    const live = !this.stopped && this.allLive();
    if (live === this.lastLive) return;
    this.lastLive = live;
    this.deps.onLiveState?.(live);
  }

  private scheduleRetry(week: string, channel: Channel): void {
    this.clearRetry(channel);
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** channel.attempts);
    channel.attempts += 1;
    channel.retry = setTimeout(() => {
      channel.retry = null;
      if (this.stopped || channel.status !== "failed" || !this.deps.isVisible()) return;
      this.connect(week);
    }, delay);
  }

  private reportOnce(detail: string): void {
    if (refusalReported) return;
    refusalReported = true;
    this.deps.reportRefusal?.(detail);
  }

  private closeChannel(channel: Channel): void {
    this.clearRetry(channel);
    const close = channel.close;
    channel.close = null;
    close?.();
  }

  private clearRetry(channel: Channel): void {
    if (channel.retry) clearTimeout(channel.retry);
    channel.retry = null;
  }

  private clear(name: "pollTimer" | "hiddenTimer" | "invalidateTimer"): void {
    const timer = this[name];
    if (timer) clearTimeout(timer);
    this[name] = null;
  }
}
