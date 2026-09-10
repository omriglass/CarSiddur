import { formatInTimeZone } from "date-fns-tz";
import { he } from "@/i18n/he";
import { TZ } from "@/lib/time";
import { servedOf } from "../applySolve";
import type { BoardRide } from "../api";
import type { WeekExportData } from "./api";
import { createXlsx, type ExcelCell, type ExcelSheet } from "./xlsx";

/** Excel stores wall-clock dates without a zone. Convert to Jerusalem before serializing. */
export function jerusalemExcelDate(instant: string | null | undefined): ExcelCell {
  if (!instant) return null;
  const local = formatInTimeZone(new Date(instant), TZ, "yyyy-MM-dd'T'HH:mm:ss");
  return { excelDate: (Date.parse(`${local}Z`) - Date.UTC(1899, 11, 30)) / 86_400_000 };
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function number(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
const shapeLabels = { round_trip: he.request.tripShapeRoundTrip, one_way_to: he.request.tripShapeOneWayTo, one_way_from: he.request.tripShapeOneWayFrom };
const copy = he.excelExport;

/**
 * The "board" (סידור) sheet — one row per ride. Shared by the Sadran's full
 * week export (`weekExportSheets` below) and the member-facing archive
 * export (`src/features/siddur/export/memberWeekWorkbook.ts`): both read
 * from the same `v_board_rides` view, RLS-permitted to any approved member
 * for a published/archived day (unlike the requests/scores sheets below,
 * which need Sadran/Admin-only tables — DATA_MODEL.md §4, `is_week_public()`).
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
      return [ride.id, carNames.get(ride.car_id ?? "") ?? ride.car_id, ride.driver_name ?? copy.noDriver, (("needs_driver" in ride && ride.needs_driver === true) || !ride.driver_id) ? copy.yes : copy.no,
        jerusalemExcelDate(ride.starts_at), jerusalemExcelDate(ride.ends_at), jerusalemExcelDate(ride.blocked_until), ride.status ? he.rideStatus[ride.status] : "",
        [...new Set(served.map((entry) => entry.destination).filter(Boolean))].join(" · "), ride.origin_name, ride.destination_name,
        served.map((entry) => entry.request_id).join("\n"), served.map((entry) => entry.requester ?? "").filter(Boolean).join("\n"), ride.notes, weekStart, departmentId, seriesDay];
    }),
  ] };
}

export function weekExportSheets(data: WeekExportData): ExcelSheet[] {
  const requests = [...data.requests].filter((r) => r.department_id === data.departmentId && r.week_start === data.weekStart)
    .sort((a, b) => (a.depart_at ?? a.return_at ?? "").localeCompare(b.depart_at ?? b.return_at ?? "") || a.id.localeCompare(b.id));
  const cars = new Map(data.cars.map((car) => [car.id, car.name]));
  const profiles = new Map(requests.map((request) => [request.requester_id, request.requester_full_name ?? request.requester_id]));
  const requestSheet: ExcelSheet = { name: copy.requestsSheet, rows: [
    [copy.requestId, copy.requester, copy.status, copy.destination, copy.tripShape, copy.depart, copy.returning, copy.preferredCar,
      copy.adults, copy.childSeats, copy.boosters, copy.luggage, copy.flexDepartEarly, copy.flexDepartLate, copy.flexReturnEarly, copy.flexReturnLate, copy.notes, copy.week, copy.department],
    ...requests.map((request) => [request.id, request.requester_full_name, he.status[request.status], request.destination_resolved_name, shapeLabels[request.trip_shape],
      jerusalemExcelDate(request.depart_at), jerusalemExcelDate(request.return_at), request.preferred_car_name ?? cars.get(request.preferred_car_id ?? ""),
      request.adults, request.child_seats, request.boosters, request.has_luggage ? copy.yes : copy.no,
      request.flex_depart_early, request.flex_depart_late, request.flex_return_early, request.flex_return_late, request.notes, data.weekStart, data.departmentId]),
  ] };
  const boardSheet = buildBoardSheet(data.rides, cars, data.weekStart, data.departmentId);
  const scoreRows: ExcelCell[][] = [[copy.policy, copy.policyVersion, copy.profile, copy.requestId, copy.score, copy.served, copy.ruleBreakdown, copy.publishedAt]];
  const publication = data.publication?.department_id === data.departmentId && data.publication.week_start === data.weekStart ? data.publication : null;
  const snapshot = object(publication?.snapshot);
  const policies = array(snapshot.policy_scores);
  const storedPolicies = policies.length ? policies : [{ policy_name: copy.selectedPolicy, policy_version_id: snapshot.policy_version_id, profiles: snapshot.profile_scores }];
  for (const policyValue of storedPolicies) {
    const policy = object(policyValue);
    for (const profileValue of array(policy.profiles)) {
      const profile = object(profileValue);
      for (const requestValue of array(profile.requests)) {
        const request = object(requestValue);
        scoreRows.push([string(policy.policy_name), string(policy.policy_version_id), profiles.get(string(profile.profile_id)) ?? string(profile.profile_id),
          string(request.request_id), number(request.score), request.served === true ? copy.yes : copy.no,
          JSON.stringify(request.breakdown ?? []), jerusalemExcelDate(publication?.published_at)]);
      }
    }
  }
  if (scoreRows.length === 1) scoreRows.push([copy.noScores]);
  return [requestSheet, boardSheet, { name: copy.scoresSheet, rows: scoreRows }];
}
export function createWeekWorkbook(data: WeekExportData): Uint8Array<ArrayBuffer> { return createXlsx(weekExportSheets(data)); }
