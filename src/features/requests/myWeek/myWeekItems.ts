// "My rides" week view (owner 2026-10-11, UX_FLOWS.md "/my week view"): turns what the member owns into
// `WeekGrid` blocks, one column per day. Pure — no React, no queries; `MyWeekView` feeds it and keeps the
// `target` of each block so a tap does what the same item does on the list view.
import type { WeekGridItemKind, WeekGridRide } from "@/components/WeekGrid";
import type { BoardRide } from "@/features/siddur/api";
import { namedPassengersOf, representativeRideTypeCode, rideViaNames, servedOf } from "@/features/rides/servedOf";
import { tv } from "@/i18n/he";
import { peopleOf } from "@/features/rides/ridePeople";
import { ridePublicDetails } from "@/lib/ridePublicDetails";
import { rideBlockLabel } from "@/lib/rideLabel";
import { viaLabel } from "@/lib/routeLabel";
import { dateKey } from "@/lib/time";

import type { MyRequestRow, TemplateSuggestion } from "../api";
import { enteredTimeLabels } from "../enteredTimes";
import { waitingFallbackLine } from "../fallbackLine";
import { windowSummary } from "../timeWindow";
import { displayStatus, originDestinationLabel } from "../myRequestsRows";
import { isAwaitingAnswer } from "../pendingProposal";
import { assignLanes } from "./assignLanes";
import { daySegments } from "./dayColumns";

/** What a tap on a block acts on — the list view's own item, never a copy. */
export type MyWeekTarget =
  | { type: "ride"; ride: BoardRide }
  | { type: "request"; row: MyRequestRow }
  | { type: "proposal"; row: MyRequestRow }
  | { type: "suggestion"; suggestion: TemplateSuggestion };

export interface MyWeekBlock {
  block: WeekGridRide;
  target: MyWeekTarget;
}

/** Statuses the week view never draws: the owner's "cancelled, withdrawn and denied are hidden". */
const HIDDEN_REQUEST_STATUSES = new Set<MyRequestRow["status"]>(["cancelled", "withdrawn", "denied"]);

/**
 * Which block a request is, or `null` when it is not drawn as a request: hidden statuses, and a placed request
 * (assigned / merged) — that one is drawn as its ride. `external` (solved outside, still offered freed cars — owner
 * 2026-10-05: like waitlisted) shows as waiting. A partly placed request reads `waitlisted` through `displayStatus`.
 */
export function requestBlockKind(row: MyRequestRow, now: number = Date.now()): WeekGridItemKind | null {
  if (HIDDEN_REQUEST_STATUSES.has(row.status)) return null;
  const status = displayStatus(row);
  if (status === "assigned" || status === "merged") return null;
  if (status === "proposed") return row.pendingProposal && isAwaitingAnswer(row.pendingProposal, now) ? "proposal" : "request";
  if (status === "waitlisted" || status === "external") return "waiting";
  if (status === "submitted" || status === "draft") return "request";
  return null;
}

/** A ride is mine when I drive it, ride as a passenger on one of my requests, or am named on it (a reservation). */
export function isMyBoardRide(ride: BoardRide, profileId: string | undefined, myRequestIds: ReadonlySet<string>): boolean {
  if (!profileId) return false;
  return ride.driver_id === profileId
    || servedOf(ride).some((entry) => !!entry.request_id && myRequestIds.has(entry.request_id))
    || namedPassengersOf(ride).some((entry) => entry.person_id === profileId);
}

/** The ride's route text, same recipe as the siddur grid (`rideBlockLabel`, multi-stop "· דרך …"). */
export function rideRouteLabel(ride: BoardRide, homeDestinationId: string | null | undefined): string {
  const served = servedOf(ride);
  const base = (!served.length && ride.notes) || (homeDestinationId && ride.origin_id && ride.destination_id
    ? rideBlockLabel({
        originId: ride.origin_id,
        destinationId: ride.destination_id,
        originName: ride.origin_name ?? "",
        destinationName: ride.destination_name ?? "",
        homeDestinationId,
        served,
        driverName: ride.driver_name,
        isChauffeur: !!ride.is_chauffeur,
        needsDriver: !!ride.needs_driver,
        autoRelocation: !!ride.auto_relocation,
        carMove: ride.pin_reason === "CAR_MOVE",
        startsAt: ride.starts_at ?? undefined,
      })
    : (ride.destination_name ?? ""));
  const via = viaLabel(rideViaNames(ride));
  return via ? `${base} · ${via}` : base;
}

/** "<car> · <route>" — the columns are days, so the car is part of the label. */
export function rideWithCarLabel(carName: string, route: string): string {
  return carName ? tv("myWeek.rideLabel", { car: carName, route }) : route;
}

export function rideBlocks(
  rides: readonly BoardRide[],
  dayKeys: readonly string[],
  labelOf: (ride: BoardRide) => string,
  /** My own requests by id: a ride serving one shows its "להגיע עד …" lines too (owner 2026-10-12). */
  myRequestsById?: ReadonlyMap<string, MyRequestRow>,
): MyWeekBlock[] {
  const out: MyWeekBlock[] = [];
  for (const ride of rides) {
    if (!ride.id || !ride.starts_at || !ride.ends_at || ride.status === "cancelled" || ride.status === "draft") continue;
    const segments = daySegments(ride.starts_at, ride.ends_at, dayKeys);
    const label = labelOf(ride);
    // Owner 2026-10-11: the ride's public notes ("notes for everyone") and passengers, exactly as the siddur block shows
    // them — they explain what the app's fields cannot. A reservation's notes are already its label.
    const served = servedOf(ride);
    const myDetails = myRequestsById
      ? served.flatMap((entry) => {
          const row = entry.request_id ? myRequestsById.get(entry.request_id) : undefined;
          return row ? requestDetailLines(row) : [];
        })
      : [];
    const description = [...new Set(myDetails), served.length ? ride.notes : null, ridePublicDetails(served, {
      includeCompanions: true,
      addedNames: peopleOf(ride).filter((person) => person.source === "added").map((person) => person.display_name),
    })].filter(Boolean).join("\n") || undefined;
    segments.forEach((segment, index) => {
      out.push({
        target: { type: "ride", ride },
        block: {
          id: index === 0 ? `ride:${ride.id}` : `ride:${ride.id}~${index}`,
          carId: segment.dayKey,
          startMinutes: segment.startMinutes,
          endMinutes: segment.endMinutes,
          label,
          description,
          isMine: true,
          needsDriver: !!ride.needs_driver,
          rideTypeCode: representativeRideTypeCode(servedOf(ride)),
          seriesIndex: ride.series_index,
          seriesCount: ride.series_count,
        },
      });
    });
  }
  return out;
}

/**
 * The request's own time details, exactly as its `/my` card shows them (owner 2026-10-12: "להגיע עד 15:30" must be
 * visible at a glance on the week view too): how each end was entered (`enteredTimes.ts`) and a time window's summary.
 */
export function requestDetailLines(row: MyRequestRow): string[] {
  const entered = enteredTimeLabels({
    departAnchor: row.departAnchor,
    arriveBy: row.arriveBy,
    returnAnchor: row.returnAnchor,
    leaveDestAt: row.leaveDestAt,
    destinationName: row.destination,
    isPickup: row.tripType === "drop_off",
  });
  const window = windowSummary({ durationLocked: row.durationLocked, departAt: row.departAt, returnAt: row.returnAt, flexReturnLate: row.flexReturnLate });
  return [entered.out, entered.return, window].filter((line): line is string => !!line);
}

/** Where an unplaced request (or suggestion) sits: out time to return time, or a one-hour block at its only time. */
function requestSpan(row: { departAt: string | null; returnAt: string | null }): { start: string; end: string | null } | null {
  if (row.departAt) return { start: row.departAt, end: row.returnAt };
  if (row.returnAt) return { start: row.returnAt, end: null };
  return null;
}

export function requestBlocks(
  rows: readonly MyRequestRow[],
  dayKeys: readonly string[],
  homeDestinationId: string | null | undefined,
  now: number = Date.now(),
): MyWeekBlock[] {
  const out: MyWeekBlock[] = [];
  // Owner 2026-10-13: a request on a day already gone is no useful information — only today onward (rides stay).
  const today = dateKey(now);
  for (const row of rows) {
    const kind = requestBlockKind(row, now);
    const span = requestSpan(row);
    if (!kind || !span) continue;
    const label = originDestinationLabel(row, homeDestinationId);
    const description = [...requestDetailLines(row), kind === "proposal" ? null : waitingFallbackLine(row)].filter(Boolean).join("\n") || undefined;
    daySegments(span.start, span.end, dayKeys).forEach((segment, index) => {
      if (segment.dayKey < today) return;
      out.push({
        target: kind === "proposal" ? { type: "proposal", row } : { type: "request", row },
        block: {
          id: index === 0 ? `${kind}:${row.id}` : `${kind}:${row.id}~${index}`,
          carId: segment.dayKey,
          startMinutes: segment.startMinutes,
          endMinutes: segment.endMinutes,
          label,
          description,
          kind,
          seriesIndex: row.seriesIndex,
          seriesCount: row.seriesCount,
        },
      });
    });
  }
  return out;
}

export function suggestionBlocks(
  suggestions: readonly TemplateSuggestion[],
  dayKeys: readonly string[],
  homeDestinationId: string | null | undefined,
): MyWeekBlock[] {
  const out: MyWeekBlock[] = [];
  for (const suggestion of suggestions) {
    const span = requestSpan(suggestion);
    if (!span) continue;
    const label = originDestinationLabel({ ...suggestion, destination: suggestion.destinationName ?? suggestion.destinationText ?? "" }, homeDestinationId);
    daySegments(span.start, span.end, dayKeys).forEach((segment, index) => {
      out.push({
        target: { type: "suggestion", suggestion },
        block: {
          id: `suggestion:${suggestion.templateId}:${suggestion.weekStart}${index === 0 ? "" : `~${index}`}`,
          carId: segment.dayKey,
          startMinutes: segment.startMinutes,
          endMinutes: segment.endMinutes,
          label,
          kind: "suggestion",
        },
      });
    });
  }
  return out;
}

/** Adds `lane`/`laneCount` to every block so items overlapping in one day sit side by side. */
export function withLanes(blocks: readonly MyWeekBlock[]): MyWeekBlock[] {
  const lanes = assignLanes(blocks.map(({ block }) => ({ id: block.id, carId: block.carId, startMinutes: block.startMinutes, endMinutes: block.endMinutes })));
  return blocks.map((entry) => {
    const lane = lanes.get(entry.block.id);
    return lane ? { ...entry, block: { ...entry.block, lane: lane.lane, laneCount: lane.laneCount } } : entry;
  });
}

/**
 * The visible start of the grid: the department's `board_start_time`, or earlier (whole hour) when an item begins
 * before it — an early ride must never be clipped off the top.
 */
export function visibleStartMinutes(blocks: readonly MyWeekBlock[], boardStartMinutes: number): number {
  const earliest = blocks.reduce((min, { block }) => Math.min(min, block.startMinutes), Number.POSITIVE_INFINITY);
  return Math.min(boardStartMinutes, Number.isFinite(earliest) ? Math.floor(earliest / 60) * 60 : boardStartMinutes);
}
