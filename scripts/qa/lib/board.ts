// The board as data (no React): loads the same rows `useBoardData` reads and derives the same
// things from the same pure modules (conflict scan, tight rides, chain breaks, connected pairs,
// draft placements, unmet cards, the drop context), so the QA Sadran's commands behave like the
// board. The solver preview used for suggestions goes through `gatherSolverContext` + `runSolve`.
import { fromZonedTime } from "date-fns-tz";

import { fetchCars, fetchCarSeatConfigs, fetchDestinations, fetchRideTypes, type Car, type Destination, type RideType } from "@/features/fleet/api";
import { isReservation } from "@/features/rides/servedOf";
import { DEFAULT_STOP_MINUTES, homeTravelEdges, makeHop, makeHopKm } from "@/lib/rideRoute";
import { TZ, dateKey } from "@/lib/time";
import * as api from "@/features/sadran/api";
import { gatherSolverContext, runSolve, servedOf } from "@/features/sadran/applySolve";
import { resolveDraftPlacements, type DraftPlacement } from "@/features/sadran/board/draftOverlay";
import type { BoardDropContext } from "@/features/sadran/board/dropValidity";
import { scanBoardConflicts, tightScheduleRideIds } from "@/features/sadran/board/geometry";
import { withRouteTravelMinutes } from "@/features/sadran/board/phantomLanes";
import { connectedPairRideIds, unmetRequestViews, viewsOnDay } from "@/features/sadran/board/unmetLegs";
import type { UnmetListItem } from "@/features/sadran/board/components/UnmetList";
import type { SolverOutput } from "@/solver";

import type { Scope } from "./common";

export interface Board {
  scope: Scope;
  week: api.WeekRow | null;
  settings: api.DepartmentSettingsRow;
  requests: api.WeekRequestRow[];
  boardRequests: api.WeekRequestRow[];
  rides: api.BoardRide[];
  cars: Car[];
  destinations: Destination[];
  rideTypes: RideType[];
  proposals: api.ProposalRow[];
  maintenance: api.MaintenanceBlockRow[];
  seatConfigsByCarId: Map<string, { adults: number; child_seats: number; boosters: number }[]>;
  carStart: Record<string, { locationId: string; baseLocationId: string }>;
  routeCtx: NonNullable<BoardDropContext["route"]>;
  weekStartMs: number;
  conflictRideIds: Set<string>;
  tightRideIds: Set<string>;
  connectedRideIds: Set<string>;
  chainBreakByRideId: Map<string, { carLocationId: string }>;
  weekEndAwayByCarId: Map<string, { locationId: string } | null>;
  awayByCarId: Map<string, { locationId: string; window: { start: number; end: number } }[]>;
  draftPlacements: DraftPlacement[];
  draftPlacedRequestIds: Set<string>;
  awaitingDriverRequestIds: Set<string | null>;
  destName: (id: string | null | undefined) => string;
  carName: (id: string | null | undefined) => string;
}

export async function loadBoard(scope: Scope): Promise<Board> {
  const { departmentId, weekStart } = scope;
  const [week, settings, requests, cars, destinations, rideTypes, maintenance, rides, proposals, seatConfigsFlat, carStart, travel] = await Promise.all([
    api.fetchWeekRow(departmentId, weekStart),
    api.fetchDepartmentSettings(departmentId),
    api.fetchWeekRequestsWithNames(departmentId, weekStart),
    fetchCars(departmentId),
    fetchDestinations(departmentId),
    fetchRideTypes(departmentId),
    api.fetchMaintenanceBlocksForDepartment(departmentId),
    api.fetchAllWeekRides(departmentId, weekStart),
    api.fetchProposalsForWeek(departmentId, weekStart),
    fetchCarSeatConfigs(departmentId),
    api.fetchCarStartLocations(departmentId, weekStart),
    api.fetchPlaceTravelForWeek(departmentId, weekStart),
  ]);
  const homeId = scope.homeDestinationId;
  const edges = [...travel, ...homeTravelEdges(homeId, destinations)];
  const routeCtx = {
    hop: makeHop(edges), hopKm: makeHopKm(edges), stopMinutes: settings.stop_minutes ?? DEFAULT_STOP_MINUTES, homeId,
    detourLimitMinutes: settings.detour_limit_minutes, detourLimitKm: settings.detour_limit_km,
  };
  const boardRequests = withRouteTravelMinutes(requests, routeCtx);
  const seatConfigsByCarId = new Map<string, { adults: number; child_seats: number; boosters: number }[]>();
  for (const sc of seatConfigsFlat) seatConfigsByCarId.set(sc.car_id, [...(seatConfigsByCarId.get(sc.car_id) ?? []), { adults: sc.adults, child_seats: sc.child_seats, boosters: sc.boosters }]);
  const weekStartMs = fromZonedTime(`${weekStart}T00:00:00`, TZ).getTime();

  const draftPlacements = resolveDraftPlacements(proposals, boardRequests, rides, homeId, routeCtx);
  const validRides = rides.filter((r): r is typeof r & { id: string; car_id: string; starts_at: string; ends_at: string; origin_id: string; destination_id: string } =>
    !!r.id && !!r.car_id && !!r.starts_at && !!r.ends_at && !!r.origin_id && !!r.destination_id);
  const days96 = Array.from({ length: 7 }, (_, i) => ({ dayIndex: i as 0 | 1 | 2 | 3 | 4 | 5 | 6, startSlot: i * 96, endSlot: i * 96 + 96, dayEndSlot: i * 96 + 95 }));
  const scan = scanBoardConflicts({
    rides: validRides.map((r) => ({ id: r.id, carId: r.car_id, startsAt: r.starts_at, endsAt: r.ends_at, originId: r.origin_id, destinationId: r.destination_id,
      turnaroundMinutes: r.turnaround_override_minutes ?? undefined, locationNeutral: isReservation(r) })),
    carIds: [...new Set(validRides.map((r) => r.car_id))],
    weekStartMs, bufferMinutes: settings.turnaround_minutes, homeLocationId: homeId, days: days96,
    carLocationsById: new Map(cars.map((c) => [c.id, { baseLocationId: c.base_location_id ?? undefined, startLocationId: carStart[c.id]?.locationId }])),
  });
  const chainBreakByRideId = new Map<string, { carLocationId: string }>();
  for (const breaks of scan.chainBreaksByCarId.values()) for (const b of breaks) chainBreakByRideId.set(b.rideId, { carLocationId: b.carLocationId });
  const tightRideIds = tightScheduleRideIds(rides.map((ride) => (isReservation(ride) ? { ...ride, origin_id: null, destination_id: null } : ride)), settings.turnaround_minutes ?? 30, {
    homeLocationId: homeId, carBaseLocationId: new Map(cars.map((c) => [c.id, c.base_location_id])),
  });
  const destNames = new Map(destinations.map((d) => [d.id, d.name]));
  const carNames = new Map(cars.map((c) => [c.id, c.name]));
  return {
    scope, week, settings, requests, boardRequests, rides, cars, destinations, rideTypes, proposals, maintenance, seatConfigsByCarId, carStart, routeCtx, weekStartMs,
    conflictRideIds: scan.conflictRideIds, tightRideIds, connectedRideIds: connectedPairRideIds(rides), chainBreakByRideId,
    weekEndAwayByCarId: scan.weekEndAwayByCarId, awayByCarId: scan.awayByCarId, draftPlacements,
    draftPlacedRequestIds: new Set(draftPlacements.map((p) => p.requestId)),
    awaitingDriverRequestIds: new Set(rides.filter((r) => r.needs_driver).flatMap((r) => servedOf(r).map((e) => e.request_id))),
    destName: (id) => (id ? destNames.get(id) ?? id.slice(0, 8) : "-"),
    carName: (id) => (id ? carNames.get(id) ?? id.slice(0, 8) : "-"),
  };
}

/** Unsolved-request cards of `day`, with the solver's reasons/suggestions attached when `output` is given. */
export function unmetItemsOf(board: Board, day: string, output?: SolverOutput | null): UnmetListItem[] {
  const views = unmetRequestViews(board.boardRequests, board.rides, { awaitingDriverRequestIds: board.awaitingDriverRequestIds, draftPlacedRequestIds: board.draftPlacedRequestIds });
  return viewsOnDay(views, day, (iso) => dateKey(new Date(iso))).map(({ request, leg }) => ({
    request, leg,
    pendingProposalId: board.proposals.find((p) => p.request_id === request.id && (p.status === "sent" || p.status === "accepted"))?.id,
    destinationName: request.destination_resolved_name ?? "-",
    solverInfo: leg === "return" ? undefined : output?.unmet.find((u) => u.requestId === request.id),
  }));
}

export function dropCtxOf(board: Board, day: string, output?: SolverOutput | null): BoardDropContext {
  return {
    rides: board.rides, requests: board.boardRequests, cars: board.cars, maintenanceBlocks: board.maintenance,
    seatConfigsByCarId: board.seatConfigsByCarId, unmetItems: unmetItemsOf(board, day, output), selectedDay: day,
    chauffeurDwellMinutes: board.settings.chauffeur_dwell_minutes ?? 10,
    awayByCarId: board.awayByCarId, weekStartMs: board.weekStartMs,
    carBaseLocationId: new Map(board.cars.map((c) => [c.id, c.base_location_id ?? board.scope.homeDestinationId])),
    homeDestinationId: board.scope.homeDestinationId, route: board.routeCtx,
  };
}

/** The real solver over the open requests, nothing applied (suggestions for `day`). */
export async function solverPreview(board: Board, policy: api.ActivePolicy): Promise<SolverOutput> {
  const context = await gatherSolverContext({ departmentId: board.scope.departmentId, weekStart: board.scope.weekStart, homeDestinationId: board.scope.homeDestinationId,
    policy: { policyId: policy.policyId, policyVersionId: policy.policyVersionId, versionNo: policy.versionNo, rules: policy.rules, settings: policy.settings }, mode: "remaining" });
  return runSolve(context.input);
}
