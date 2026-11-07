// REQ §13.185 (g): a refused board drop names what is in the way. Pure: the board's already-loaded rides and draft
// placements on the target car, compared with the dropped window (plus the week's turnaround gap).
import { formatTime } from "@/lib/time";
import { AppError, type ErrorCode } from "@/lib/rpc";
import { he, tv } from "@/i18n/he";

export interface CarBlock {
  startsAt: string;
  endsAt: string;
  /** Who it belongs to (requester / driver / reservation label); empty when unknown. */
  name: string;
  /** A Sadran draft (a draft placement or a drafted ride), not a booked ride. */
  isDraft: boolean;
  /** The board click id that opens it (`draft:<proposal>` or the drafted ride's id) — DB2's "פתח טיוטה". */
  openId?: string;
}

/** A refusal toast: the line, and for a draft in the way an action that opens it (DB2). */
export interface RefusalToast {
  line: string;
  action?: { label: string; onClick: () => void };
}

export interface Obstacle extends CarBlock {
  /** True when the windows do not overlap but the turnaround gap between them is too short. */
  turnaroundOnly: boolean;
}

/** The block on the car that best explains a refusal: a real overlap first (earliest), else the closest turnaround clash. */
export function findObstacle(
  window: { startsAt: string; endsAt: string },
  blocks: readonly CarBlock[],
  turnaroundMinutes: number,
): Obstacle | null {
  const start = Date.parse(window.startsAt);
  const end = Date.parse(window.endsAt);
  const gap = turnaroundMinutes * 60_000;
  const hits = blocks.flatMap((block): Obstacle[] => {
    const bs = Date.parse(block.startsAt);
    const be = Date.parse(block.endsAt);
    if (!(start < be && bs < end)) {
      return start < be + gap && bs < end + gap ? [{ ...block, turnaroundOnly: true }] : [];
    }
    return [{ ...block, turnaroundOnly: false }];
  });
  hits.sort((a, b) => Number(a.turnaroundOnly) - Number(b.turnaroundOnly) || Date.parse(a.startsAt) - Date.parse(b.startsAt));
  return hits[0] ?? null;
}

const CAR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(["ride_overlap", "ride_turnaround", "ride_unavailable"]);

/** The toast line for a refused drop, or null to keep the per-code message. */
export function describeObstacle(error: AppError, obstacle: Obstacle | null): string | null {
  if (!obstacle || !CAR_CODES.has(error.code)) return null;
  const name = obstacle.name || he.sadranBoard.refusal.someone;
  const start = formatTime(new Date(obstacle.startsAt));
  const end = formatTime(new Date(obstacle.endsAt));
  if (obstacle.turnaroundOnly) return tv("sadranBoard.refusal.turnaround", { name, start, end });
  return obstacle.isDraft
    ? tv("sadranBoard.refusal.draft", { name, start })
    : tv("sadranBoard.refusal.ride", { name, start, end });
}
