import { formatInTimeZone } from "date-fns-tz";

import type { ExcelCell, ExcelSheet } from "@/lib/xlsx";
import { he } from "@/i18n/he";
import { TZ } from "@/lib/time";

import { servedOf } from "../servedOf";
import { peopleOf } from "../ridePeople";

import type { BoardRide } from "../api";

const copy = he.excelExport;

/** Excel stores wall-clock dates without a zone. Convert to Jerusalem before serializing. */
export function jerusalemExcelDate(instant: string | null | undefined): ExcelCell {
  if (!instant) return null;
  const local = formatInTimeZone(new Date(instant), TZ, "yyyy-MM-dd'T'HH:mm:ss");
  return { excelDate: (Date.parse(`${local}Z`) - Date.UTC(1899, 11, 30)) / 86_400_000 };
}

/**
 * The "board" (סידור) sheet — one row per ride. Shared by the Sadran's full week export
 * (`sadran/export/weekWorkbook.ts`'s `weekExportSheets`) and the member-facing archive export
 * (`src/features/siddur/export/memberWeekWorkbook.ts`): both read from the same `v_board_rides`
 * view, RLS-permitted to any approved member for a published/archived day (unlike the
 * requests/scores sheets, which need Sadran/Admin-only tables — DATA_MODEL.md §4,
 * `is_week_public()`). Moved here from `sadran/export/weekWorkbook.ts` (R8: break the siddur ⇄
 * sadran import cycle) since it's shared, not sadran-specific.
 */
export function buildBoardSheet(rides: readonly BoardRide[], carNames: ReadonlyMap<string, string>, weekStart: string, departmentId: string): ExcelSheet {
  const sortedRides = [...rides].filter((r) => r.department_id === departmentId && r.week_start === weekStart && r.status !== "cancelled")
    .sort((a, b) => (a.starts_at ?? "").localeCompare(b.starts_at ?? "") || (a.id ?? "").localeCompare(b.id ?? ""));
  return { name: copy.boardSheet, rows: [
    [copy.rideId, copy.car, copy.driver, copy.needsDriver, copy.startsAt, copy.endsAt, copy.blockedUntil, copy.status,
      copy.destination, copy.origin, copy.carEnd, copy.requestId, copy.passengers, copy.notes, copy.week, copy.department, copy.seriesDay],
    ...sortedRides.map((ride) => {
      const served = servedOf(ride);
      // Multi-day request leg (REQ §13.77) — "index/count", blank for an ordinary ride.
      const seriesDay = "series_index" in ride && "series_count" in ride && ride.series_index && ride.series_count
        ? `${ride.series_index}/${ride.series_count}` : "";
      // Passengers column: every named person on the ride (unified `people`, REQ §13.85) —
      // not just each served request's requester, so a directly `add_ride_passengers()`-added
      // person is not invisible to this export either.
      const passengerNames = peopleOf(ride).filter((person) => person.source !== "driver").map((person) => person.display_name);
      return [ride.id, carNames.get(ride.car_id ?? "") ?? ride.car_id, ride.driver_name ?? copy.noDriver, (("needs_driver" in ride && ride.needs_driver === true) || !ride.driver_id) ? copy.yes : copy.no,
        jerusalemExcelDate(ride.starts_at), jerusalemExcelDate(ride.ends_at), jerusalemExcelDate(ride.blocked_until), ride.status ? he.rideStatus[ride.status] : "",
        [...new Set(served.map((entry) => entry.destination).filter(Boolean))].join(" · "), ride.origin_name, ride.destination_name,
        served.map((entry) => entry.request_id).join("\n"), passengerNames.join("\n"), ride.notes, weekStart, departmentId, seriesDay];
    }),
  ] };
}
