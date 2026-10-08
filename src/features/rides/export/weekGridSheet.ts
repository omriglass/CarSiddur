import { fromZonedTime } from "date-fns-tz";

import { he, tv } from "@/i18n/he";
import { weekdayLabel, formatDayDate } from "@/lib/dayLabels";
import { parseRideRoute } from "@/lib/rideRoute";
import { rideBlockLabel } from "@/lib/rideLabel";
import { viaLabel } from "@/lib/routeLabel";
import { TZ, dateKey, formatTime } from "@/lib/time";
import type { ExcelCell, ExcelSheet } from "@/lib/xlsx";

import type { BoardRide } from "../api";
import { peopleOf } from "../ridePeople";
import { ridePassengerParts } from "@/lib/ridePassengerSummary";
import { whoText } from "@/features/requests/whoLabel";
import { relayPartnerOf, representativeRideTypeCode, rideViaNames, servedOf } from "../servedOf";

/**
 * The "סידור" sheet as the on-screen week table (owner 2026-10-08): per day, top to bottom, a
 * title row, a car-names row and one row per 15 minutes; a column per car; each ride one merged
 * block. A day-name column (one letter per row) sits at both ends, a time column next to the
 * right one. Pure; shared by the Sadran export and the archive export.
 */
export const SLOT_MINUTES = 15;
const DEFAULT_START = 6 * 60;
const DEFAULT_END = 23 * 60;
/** [whole-day tint, stronger tint for the day-letter columns] — alternating by day. */
const DAY_SHADES = [["#EAF2FB", "#CFE0F3"], ["#F8F2E4", "#EBDDBB"]] as const;
const RIDE_FILL: Record<string, string> = {
  work: "#C9CEEA", childcare: "#F4CADF", healthcare: "#C1E7E2", errands: "#FBD5BB", other: "#D5D7DB",
};
const NEEDS_DRIVER_FILL = "#FBD0D0";

export interface GridCar { id: string; name: string; type?: string | null; status?: string | null }
export interface GridOptions { homeDestinationId?: string | null; boardStartTime?: string | null }

function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
  return name;
}
function minutesOfDay(instant: string): number {
  const [h, m] = formatTime(new Date(instant)).split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
function weekDayKeys(weekStart: string): string[] {
  const [y, m, d] = weekStart.split("-").map(Number) as [number, number, number];
  return Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10));
}

interface Block { ride: BoardRide; carId: string; day: number; start: number; end: number; lane: number }

/** Same people wording as the /my cards ("דני כהן ועוד מבוגר/ת"); empty when nobody is listed. */
function whoLine(ride: BoardRide, served: ReturnType<typeof servedOf>, addedNames: string[]): string {
  const { names, adults, children } = ridePassengerParts(served, ride.needs_driver ? null : ride.driver_name, { addedNames });
  return names.length || adults || children ? whoText(names, adults, children) : "";
}

/** Text lines of one ride block — the siddur's own label helpers, nothing new. */
export function rideBlockLines(ride: BoardRide, homeDestinationId: string | null | undefined): string[] {
  const served = servedOf(ride);
  const base = (!served.length && ride.notes) || (homeDestinationId && ride.origin_id && ride.destination_id
    ? rideBlockLabel({
      originId: ride.origin_id, destinationId: ride.destination_id, originName: ride.origin_name ?? "",
      destinationName: ride.destination_name ?? "", homeDestinationId, served, driverName: ride.driver_name,
      isChauffeur: !!ride.is_chauffeur, needsDriver: !!ride.needs_driver, autoRelocation: !!ride.auto_relocation,
      carMove: ride.pin_reason === "CAR_MOVE", startsAt: ride.starts_at ?? undefined, relayPartner: relayPartnerOf(ride),
    })
    : (ride.destination_name ?? ""));
  const via = viaLabel(rideViaNames(ride));
  const baseRequestId = (served.find((e) => e.role === "driver") ?? served[0])?.request_id ?? null;
  const merged = parseRideRoute(ride.route).some((p) => (p.kind === "board" || p.kind === "alight") && p.requestId !== baseRequestId);
  const first = [base, via, merged ? he.mergedRide.marker : ""].filter(Boolean).join(" · ");
  const addedNames = peopleOf(ride).filter((p) => p.source === "added").map((p) => p.display_name);
  const lines = [
    first,
    `\u202A${tv("excelExport.timeRange", { start: formatTime(new Date(ride.starts_at as string)), end: formatTime(new Date(ride.ends_at as string)) })}\u202C`,
    whoLine(ride, served, addedNames),
    ride.needs_driver ? he.boardCoordination.needsDriver : "",
    ride.series_count && ride.series_count > 1 ? tv("ride.seriesDay", { index: String(ride.series_index ?? 1), count: String(ride.series_count) }) : "",
  ];
  return lines.filter(Boolean);
}

export function buildWeekGridSheet(rides: readonly BoardRide[], cars: readonly GridCar[], weekStart: string, departmentId: string, options: GridOptions = {}): ExcelSheet {
  const dayKeys = weekDayKeys(weekStart);
  const live = rides.filter((r) => r.department_id === departmentId && r.week_start === weekStart && r.status !== "cancelled"
    && r.car_id && r.starts_at && r.ends_at && dayKeys.includes(dateKey(r.starts_at)));

  // Columns: shared cars + private cars only when they have a ride this week; unknown cars with rides appended.
  const withRides = new Set(live.map((r) => r.car_id as string));
  const known = new Set(cars.map((c) => c.id));
  const columnsCars: GridCar[] = [
    ...cars.filter((c) => withRides.has(c.id) || (c.type !== "temporary" && c.status !== "retired")),
    ...[...withRides].filter((id) => !known.has(id)).sort().map((id) => ({ id, name: id })),
  ];

  // Blocks, snapped to the 15-minute grid, with lanes so nothing in one car overlaps.
  const blocks: Block[] = live.map((ride) => {
    const sMin = minutesOfDay(ride.starts_at as string);
    const eMin = Math.min(1440, sMin + (Date.parse(ride.ends_at as string) - Date.parse(ride.starts_at as string)) / 60_000);
    const start = Math.min(1440 - SLOT_MINUTES, Math.floor(sMin / SLOT_MINUTES) * SLOT_MINUTES);
    return { ride, carId: ride.car_id as string, day: dayKeys.indexOf(dateKey(ride.starts_at as string)), start,
      end: Math.max(start + SLOT_MINUTES, Math.ceil(eMin / SLOT_MINUTES) * SLOT_MINUTES), lane: 0 };
  }).sort((a, b) => a.day - b.day || a.start - b.start || a.end - b.end || (a.ride.id ?? "").localeCompare(b.ride.id ?? ""));
  const laneCount = new Map<string, number>(columnsCars.map((c) => [c.id, 1]));
  for (const car of columnsCars) {
    for (let day = 0; day < 7; day++) {
      const laneEnds: number[] = [];
      for (const block of blocks.filter((b) => b.carId === car.id && b.day === day)) {
        let lane = laneEnds.findIndex((end) => end <= block.start);
        if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); }
        laneEnds[lane] = block.end;
        block.lane = lane;
      }
      laneCount.set(car.id, Math.max(laneCount.get(car.id) ?? 1, laneEnds.length));
    }
  }
  const firstCol = new Map<string, number>();
  let col = 2; // 0 = day letters, 1 = time
  for (const car of columnsCars) { firstCol.set(car.id, col); col += laneCount.get(car.id) ?? 1; }
  const lastCol = col; // trailing day-letters column
  const width = lastCol + 1;

  const settingsStart = options.boardStartTime ? (() => { const m = /^(\d+):(\d+)/.exec(options.boardStartTime) ; return m ? Number(m[1]) * 60 + Number(m[2]) : DEFAULT_START; })() : DEFAULT_START;
  const gridStart = Math.min(DEFAULT_START, Math.floor(settingsStart / SLOT_MINUTES) * SLOT_MINUTES);

  const rows: ExcelCell[][] = [];
  const merges: string[] = [];
  const rowHeights: (number | undefined)[] = [];
  const empty = (): ExcelCell[] => Array.from({ length: width }, () => null);

  // Row 1: the one frozen header — car names only, nothing day-specific.
  const carRow: ExcelCell[] = empty().map((): ExcelCell => ({ text: null, style: "carHeader" }));
  carRow[1] = { text: he.excelExport.timeColumn, style: "carHeader" };
  for (const car of columnsCars) {
    const c = firstCol.get(car.id) as number, lanes = laneCount.get(car.id) ?? 1;
    carRow[c] = { text: car.name, style: "carHeader" };
    if (lanes > 1) merges.push(`${columnName(c)}1:${columnName(c + lanes - 1)}1`);
  }
  rows.push(carRow); rowHeights.push(32);

  for (let day = 0; day < 7; day++) {
    const dayBlocks = blocks.filter((b) => b.day === day);
    const start = Math.min(gridStart, ...dayBlocks.map((b) => b.start));
    const end = Math.max(DEFAULT_END, ...dayBlocks.map((b) => b.end));
    const instant = fromZonedTime(`${dayKeys[day]}T12:00:00`, TZ);
    const [tint, strong] = DAY_SHADES[day % 2]!;
    const letters = [...weekdayLabel(instant, "long")];

    if (day > 0) { rows.push(empty()); rowHeights.push(8); }
    const titleRow = empty().map((): ExcelCell => ({ text: null, style: "title" }));
    titleRow[0] = { text: tv("excelExport.dayTitle", { date: formatDayDate(instant) }), style: "title" };
    rows.push(titleRow); rowHeights.push(24);
    merges.push(`A${rows.length}:${columnName(width - 1)}${rows.length}`);

    const firstSlotRow = rows.length; // 0-based index of the first slot row
    for (let m = start, i = 0; m < end; m += SLOT_MINUTES, i++) {
      const row: ExcelCell[] = empty().map((): ExcelCell => ({ text: null, style: "grid", fill: tint }));
      const letter: ExcelCell = { text: letters[i % letters.length] ?? "", style: "time", fill: strong };
      row[0] = letter; row[lastCol] = letter;
      row[1] = { text: hhmm(m), style: m % 60 === 0 ? "time" : "timeMinor", fill: tint };
      rows.push(row); rowHeights.push(15);
    }
    for (const block of dayBlocks) {
      const c = (firstCol.get(block.carId) as number) + block.lane;
      const r0 = firstSlotRow + (block.start - start) / SLOT_MINUTES;
      const r1 = Math.min(rows.length - 1, firstSlotRow + (block.end - start) / SLOT_MINUTES - 1);
      const fill = block.ride.needs_driver ? NEEDS_DRIVER_FILL : (RIDE_FILL[representativeRideTypeCode(servedOf(block.ride)) ?? "other"] ?? RIDE_FILL.other);
      for (let r = r0; r <= r1; r++) rows[r]![c] = { text: r === r0 ? rideBlockLines(block.ride, options.homeDestinationId).join("\n") : null, style: "ride", fill };
      if (r1 > r0) merges.push(`${columnName(c)}${r0 + 1}:${columnName(c)}${r1 + 1}`);
    }
  }

  const columnWidths = Array.from({ length: width }, (_, i) => (i === 0 || i === lastCol ? 4 : i === 1 ? 8 : 22));
  return { name: he.excelExport.boardSheet, rows, merges, freezeRows: 1, freezeCols: 2, columnWidths, rowHeights, autoFilter: false, headerRow: false };
}
