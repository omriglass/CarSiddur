// REQ item 246 (LT1, owner 2026-11-16): the one timing rule of a request's route. Every place may
// carry at most ONE fixed hour — arrive by (the places before it are timed backwards from it) or
// leave at (the places after it are timed forwards from it) — widened by its flexibility; a stay
// is optional. Everything else is worked out ("~"). Between two fixed hours the spare time goes
// to the destination's unset stay, else it is waiting at the later one ("early"); missing time
// is taken, in order, from a stay the member gave (only when `allowShrink`, i.e. when an option
// for adding a stop is priced), then from the later fixed hour's flexibility; past that it is a
// conflict. SQL twin: `public.request_schedule()` — keep the two identical (shared cases in
// `supabase/tests/fixtures/stop_schedule_cases.json`). Pure: minutes of the day in, minutes out.

export type StopAnchor = "arrive" | "leave";

export interface FixedHour {
  anchor: StopAnchor;
  /** Minute of the day. */
  at: number;
  /** Minutes the hour may slip (an arrive-by: arrive up to `flex` later; a leave-at: leave up to `flex` later). */
  flex: number;
}

export type PointKind = "start" | "stop" | "destArrive" | "destLeave" | "end";

export interface SchedulePoint {
  /** Stable id of the point (form key). */
  key: string;
  /** Travel key: two points with the same place key are 0 minutes apart. */
  place: string;
  kind: PointKind;
  /** Minutes there; null = not given (worked out / the department's stop minutes). Ignored for start, end and destLeave. */
  stay: number | null;
  fixed: FixedHour | null;
}

export interface ScheduleOptions {
  travel: (from: string, to: string) => number;
  /** The department's stop minutes (a short unset stop). */
  stopMinutes: number;
  /** Departure when nothing is fixed (minute of the day). */
  defaultStart: number;
  /** Price an added stop: a stay the member gave may be shortened. */
  allowShrink?: boolean;
}

export interface ScheduledPoint {
  key: string;
  arrive: number;
  leave: number;
  /** The minutes actually spent there. */
  stay: number;
  /** The stay was worked out (show with "~"). */
  stayWorkedOut: boolean;
  /** Arriving this many minutes before a fixed arrive-by (waiting there). */
  early: number;
  /** This fixed hour slipped by this many minutes, within its flexibility. */
  flexUsed: number;
  /** A stay the member gave was shortened by this many minutes. */
  shortenedBy: number;
}

export interface ScheduleConflict {
  /** The fixed point that cannot be reached in time, even with its flexibility. */
  key: string;
  lateBy: number;
}

export interface Schedule {
  points: ScheduledPoint[];
  conflict: ScheduleConflict | null;
  /** Nothing tells when the way back starts: no fixed hour after the destination and no stay there. */
  needsReturnHour: boolean;
}

const hasStay = (p: SchedulePoint, i: number, n: number) => i > 0 && i < n - 1 && p.kind !== "destLeave";

export function schedule(points: readonly SchedulePoint[], options: ScheduleOptions): Schedule {
  const n = points.length;
  const { travel, stopMinutes } = options;
  const P = (i: number): SchedulePoint => points[i]!;
  const workedOut = points.map((p, i) => hasStay(p, i, n) && p.stay == null);
  const st = points.map((p, i) => (hasStay(p, i, n) ? (p.stay ?? stopMinutes) : 0));
  const a = new Array<number>(n).fill(0);
  const l = new Array<number>(n).fill(0);
  const early = new Array<number>(n).fill(0);
  const flexUsed = new Array<number>(n).fill(0);
  const shortened = new Array<number>(n).fill(0);
  const at = (arr: number[], i: number): number => arr[i]!;
  let conflict: ScheduleConflict | null = null;
  const T = (i: number, j: number) => (P(i).place === P(j).place ? 0 : travel(P(i).place, P(j).place));
  const anchorOf = (i: number) => P(i).fixed?.anchor;

  const fixedIdx = points.flatMap((p, i) => (p.fixed ? [i] : []));
  let anchors = fixedIdx;
  if (anchors.length === 0) {
    a[0] = options.defaultStart;
    l[0] = options.defaultStart;
    anchors = [0];
  } else {
    for (const k of anchors) {
      const f = P(k).fixed!;
      if (f.anchor === "arrive") { a[k] = f.at; l[k] = f.at + at(st, k); } else { l[k] = f.at; a[k] = f.at - at(st, k); }
    }
  }
  const first = anchors[0]!;
  const last = anchors[anchors.length - 1]!;
  // Before the first fixed hour: backwards.
  for (let i = first - 1; i >= 0; i--) { l[i] = at(a, i + 1) - T(i, i + 1); a[i] = at(l, i) - at(st, i); }

  const run = (j: number, m: number): number => {
    if (anchorOf(j) === "arrive") l[j] = at(a, j) + at(st, j);
    let lp = at(l, j);
    for (let k = j + 1; k < m; k++) { a[k] = lp + T(k - 1, k); l[k] = at(a, k) + at(st, k); lp = at(l, k); }
    return lp + T(m - 1, m);
  };

  for (let q = 1; q < anchors.length; q++) {
    const j = anchors[q - 1]!;
    const m = anchors[q]!;
    const fm = P(m).fixed!;
    const due = fm.anchor === "arrive" ? fm.at : fm.at - at(st, m);
    let late = run(j, m) - due;
    if (late < 0) {
      const target = rangeOf(j, m).find((k) => k > 0 && workedOut[k] && P(k).kind === "destArrive" && !(k === j && anchorOf(j) === "leave"));
      if (target !== undefined) { st[target] = at(st, target) - late; run(j, m); late = 0; } else early[m] = -late;
    } else if (late > 0 && options.allowShrink) {
      const given = rangeOf(j, m)
        .filter((k) => k > 0 && hasStay(P(k), k, n) && !workedOut[k] && !(k === j && anchorOf(j) === "leave") && at(st, k) > stopMinutes)
        .sort((x, y) => at(st, y) - at(st, x) || x - y);
      for (const k of given) {
        if (late <= 0) break;
        const take = Math.min(late, at(st, k) - stopMinutes);
        st[k] = at(st, k) - take; shortened[k] = at(shortened, k) + take; late -= take;
      }
      late = run(j, m) - due;
    }
    if (late > 0 && late <= fm.flex) { flexUsed[m] = late; a[m] = at(a, m) + late; l[m] = at(l, m) + late; late = 0; }
    if (late > 0 && !conflict) conflict = { key: P(m).key, lateBy: late };
  }
  // After the last fixed hour: forwards.
  for (let i = last + 1; i < n; i++) { a[i] = at(l, i - 1) + T(i - 1, i); l[i] = at(a, i) + at(st, i); }

  const dest = points.findIndex((p) => p.kind === "destArrive");
  const hasWayBack = points.some((p) => p.kind === "destLeave");
  const needsReturnHour = hasWayBack && dest >= 0 && !!workedOut[dest] && !fixedIdx.some((k) => k > dest);
  return {
    points: points.map((p, i) => ({
      key: p.key, arrive: at(a, i), leave: at(l, i), stay: at(st, i), stayWorkedOut: !!workedOut[i],
      early: at(early, i), flexUsed: at(flexUsed, i), shortenedBy: at(shortened, i),
    })),
    conflict,
    needsReturnHour,
  };
}

function rangeOf(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, i) => from + i);
}

/** The car's window: the first departure and the last arrival. */
export function carWindow(s: Schedule): { start: number; end: number } {
  return { start: s.points[0]?.leave ?? 0, end: s.points[s.points.length - 1]?.arrive ?? 0 };
}

export type Leg = "out" | "return";

export interface InsertOption {
  /** Insert the new point before the point at this index of the current list. */
  beforeIndex: number;
  ok: boolean;
  /** Smaller = fewer changes; the list comes sorted by it (ties: route order). */
  cost: number;
  points: SchedulePoint[];
  schedule: Schedule;
  /** The new place's ~arrival. */
  newArrive: number;
  /** Minutes the departure from home moves earlier (≥ 0). */
  departEarlier: number;
  /** Minutes the way back leaves the destination earlier (+) or later (−); 0 when that hour is fixed. */
  destLeaveEarlier: number;
  /** Minutes home moves later (≥ 0). */
  homeLater: number;
  shortened: { key: string; minutes: number }[];
  flexUsed: { key: string; minutes: number }[];
}

/**
 * One option per position of `leg` for a new point (owner 2026-11-16: "before Metzer or after").
 * Fixed hours never move; worked-out time goes first, then a given stay, then flexibility (×2 in
 * the cost, so an option that spends flexibility comes after an equal one that does not).
 */
export function insertOptions(points: readonly SchedulePoint[], leg: Leg, added: SchedulePoint, options: ScheduleOptions): InsertOption[] {
  const base = schedule(points, options);
  const dest = points.findIndex((p) => p.kind === "destArrive");
  const destLeave = points.findIndex((p) => p.kind === "destLeave");
  const from = leg === "out" ? 1 : (destLeave >= 0 ? destLeave + 1 : points.length);
  const to = leg === "out" ? dest : points.length - 1;
  const out: InsertOption[] = [];
  for (let at = from; at <= to; at++) {
    const next = [...points.slice(0, at), added, ...points.slice(at)];
    const s = schedule(next, { ...options, allowShrink: true });
    const byKey = new Map(s.points.map((p) => [p.key, p]));
    const baseByKey = new Map(base.points.map((p) => [p.key, p]));
    const departEarlier = Math.max(0, (base.points[0]?.leave ?? 0) - (s.points[0]?.leave ?? 0));
    const homeLater = Math.max(0, (s.points[s.points.length - 1]?.arrive ?? 0) - (base.points[base.points.length - 1]?.arrive ?? 0));
    let destLeaveEarlier = 0;
    if (dest >= 0 && !(destLeave >= 0 && points[destLeave]?.fixed)) {
      const k = points[dest]!.key;
      destLeaveEarlier = (baseByKey.get(k)?.leave ?? 0) - (byKey.get(k)?.leave ?? 0);
    }
    const shortened = s.points.filter((p) => p.shortenedBy > 0).map((p) => ({ key: p.key, minutes: p.shortenedBy }));
    const flexUsed = s.points.filter((p) => p.flexUsed > (baseByKey.get(p.key)?.flexUsed ?? 0))
      .map((p) => ({ key: p.key, minutes: p.flexUsed }));
    const cost = s.conflict ? Number.POSITIVE_INFINITY
      : departEarlier + Math.abs(destLeaveEarlier) + homeLater
        + shortened.reduce((t, x) => t + x.minutes, 0)
        + 2 * flexUsed.reduce((t, x) => t + x.minutes - (baseByKey.get(x.key)?.flexUsed ?? 0), 0);
    out.push({
      beforeIndex: at, ok: !s.conflict, cost, points: next, schedule: s,
      newArrive: byKey.get(added.key)?.arrive ?? 0,
      departEarlier, destLeaveEarlier, homeLater, shortened, flexUsed,
    });
  }
  return out.sort((x, y) => x.cost - y.cost || x.beforeIndex - y.beforeIndex);
}
