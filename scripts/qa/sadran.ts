// `npm run qa:sadran -- <command>` — what the board does, as the QA Sadran, through the app's own
// api functions / RPCs (so behaviour matches the UI). Output is compact English text for an LLM.
import { formatTime, dateKey } from "@/lib/time";
import { formatMinutes, parseHHMM } from "@/components/timeField15Format";
import { fromZonedTime } from "date-fns-tz";
import { TZ } from "@/lib/time";
import { parseFlexInterval } from "@/features/solverBridge/buildSolverInput";
import { parseRideRoute } from "@/lib/rideRoute";
import { fetchProfilesByIds } from "@/features/sadran/api";
import * as api from "@/features/sadran/api";
import {
  buildApplyPayload, computeFullResolveDiff, gatherSolverContext, hashSolverInput, nowMs, runSolve, servedOf, servedToEditRideLegs, rideViaNames,
  restrictInputToDay,
} from "@/features/sadran/applySolve";
import { publishWithScores } from "@/features/sadran/publish/publishWithScores";
import { buildDraftInput, type ComposerPrefill } from "@/features/sadran/board/draftInput";
import {
  connectsOtherLeg, isUnmetDropValid, minutesIso, originMismatch, passengersOf, privateCarBlocks, seatsFit, strandsNextRide,
  unavailable, unmetCandidateWindow, unmetPlacement, unmetRequestPassengers, unmetShiftPayload, carLocationAt,
} from "@/features/sadran/board/dropValidity";
import { mergeInvalidReason, mergePayload, mergePayloadLeg, type MergeLeg } from "@/features/sadran/board/mergeProposal";
import { requestStart, requestWithinFlex, tripTypeOf } from "@/features/sadran/board/phantomLanes";
import { initialRouteEditValues, reservationRoutePlaces, routeEditChanged, routeEditPayload, type RouteEditValues } from "@/features/sadran/board/rideRouteEdit";
import { isDropOffWithPickup, coveredLegs } from "@/features/sadran/board/unmetLegs";
import { fetchWhatsappTemplates } from "@/features/sadran/api";
import { addRidePassengers } from "@/features/rides/api";
import { activeSeriesLegs, buildSeriesSpan, seriesHead, seriesSpanPrefill } from "@/features/sadran/board/seriesSpan";
import { slotToIso } from "@/features/sadran/board/geometry";
import { supabase } from "@/integrations/supabase/client";
import type { DestinationValue } from "@/components/DestinationCombobox";
import type { Json } from "@/integrations/supabase/types";
import type { Suggestion } from "@/solver";
import { createClient } from "@supabase/supabase-js";

import { loadBoard, dropCtxOf, draftHiddenRideIds, solverPreview, unmetItemsOf, type Board } from "./lib/board";
import {
  UsageError, appendMail, resolvePlaceToken, flag, flagAll, has, mailFor, need, outDir, parseArgs, printMail, resolveId, resolveScope, run, sadranFromPersonas, short, signIn, DEMO_PASSWORD,
  type Args, type Scope,
} from "./lib/common";

// --- small helpers --------------------------------------------------------------------------

const t = (iso: string | null | undefined): string => (iso ? formatTime(new Date(iso)) : "--:--");
const dayOf = (iso: string | null | undefined): string => (iso ? dateKey(new Date(iso)) : "");
const minutesOfDay = (day: string, hhmm: string): number => {
  const m = parseHHMM(hhmm);
  if (m == null) throw new UsageError(`bad time ${hhmm} (want HH:MM)`);
  void day;
  return m;
};
const instantAt = (day: string, hhmm: string): string => {
  const m = minutesOfDay(day, hhmm);
  return fromZonedTime(`${day}T${formatMinutes(m)}:00`, TZ).toISOString();
};
const flexText = (early: string | null | undefined, late: string | null | undefined): string => {
  const f = (raw: string | null | undefined) => { const v = parseFlexInterval(raw); return v === "day" ? "day" : String(v); };
  return `-${f(early)}/+${f(late)}m`;
};

function seatsOfCar(board: Board, carId: string): string {
  const configs = board.seatConfigsByCarId.get(carId) ?? [];
  if (!configs.length) return "?";
  return configs.map((c) => `${c.adults}a${c.child_seats ? `+${c.child_seats}cs` : ""}${c.boosters ? `+${c.boosters}b` : ""}`).join("|");
}

function resolveCar(board: Board, token: string) {
  const exact = board.cars.filter((c) => c.id === token || c.name === token || c.id.startsWith(token) || (token.length >= 4 && c.id.endsWith(token)));
  const found = exact.length ? exact : board.cars.filter((c) => c.name.toLowerCase().includes(token.toLowerCase()));
  if (found.length !== 1) throw new UsageError(`car '${token}' ${found.length ? "is ambiguous" : "not found"} (cars: ${board.cars.map((c) => `${c.name}=${short(c.id)}`).join(", ")})`);
  return found[0]!;
}
const resolveRequest = (board: Board, prefix: string) => board.boardRequests.find((r) => r.id === resolveId(prefix, board.requests.map((x) => x.id), "request"))!;
const resolveRide = (board: Board, prefix: string) => board.rides.find((r) => r.id === resolveId(prefix, board.rides.flatMap((x) => (x.id ? [x.id] : [])), "ride"))!;

const resolvePlace = (board: Board, token: string): DestinationValue => resolvePlaceToken(board.destinations, token);

function servedText(ride: api.BoardRide): string {
  return servedOf(ride).map((e) => `${e.requester ?? "?"}[${short(e.request_id)} ${e.role === "driver" ? "drv" : "pax"} ${e.leg} ${e.car_mode} ${e.adults}a${e.child_seats ? `+${e.child_seats}cs` : ""}${e.boosters ? `+${e.boosters}b` : ""}${e.destination ? ` to ${e.destination}` : ""}${e.trip_type ? ` ${e.trip_type}` : ""}]`).join(" ; ");
}

function rideFlags(board: Board, ride: api.BoardRide): string[] {
  const id = ride.id ?? "";
  const flags: string[] = [];
  flags.push(`status=${ride.status}`);
  if (ride.is_pinned) flags.push("pinned");
  if (ride.needs_driver) flags.push("NEEDS-DRIVER");
  if (!servedOf(ride).length) flags.push(ride.auto_relocation ? "auto-relocation" : "reservation");
  if (parseRideRoute(ride.route).some((p) => p.kind === "board" || p.kind === "alight")) flags.push("merged");
  if (board.connectedRideIds.has(id)) flags.push("connected");
  if (board.tightRideIds.has(id)) flags.push("tight");
  if (board.conflictRideIds.has(id)) flags.push("CONFLICT");
  const cb = board.chainBreakByRideId.get(id);
  if (cb) flags.push(`CHAIN-BREAK(car is at ${board.destName(cb.carLocationId)})`);
  if (ride.series_id) flags.push(`series ${ride.series_index}/${ride.series_count}`);
  if (ride.is_chauffeur) flags.push("chauffeur");
  const pending = board.proposals.find((p) => p.ride_id === id && ["draft", "sent", "accepted"].includes(p.status));
  if (pending) flags.push(`proposal:${pending.status}/${pending.type}/${short(pending.id)}`);
  if (ride.notes) flags.push(`notes="${ride.notes}"`);
  return flags;
}

function rideLine(board: Board, ride: api.BoardRide): string {
  const via = rideViaNames(ride);
  const viaText = [via.out.length ? `via(out) ${via.out.join(",")}` : "", via.return.length ? `via(ret) ${via.return.join(",")}` : ""].filter(Boolean).join(" ");
  const route = ride.origin_id === ride.destination_id ? `round@${board.destName(ride.origin_id)}` : `${board.destName(ride.origin_id)}->${board.destName(ride.destination_id)}`;
  return `  ride ${short(ride.id)} ${t(ride.starts_at)}-${t(ride.ends_at)} ${route}${viaText ? ` ${viaText}` : ""} driver=${ride.needs_driver ? "-" : ride.driver_name ?? "-"} v${ride.version} | ${servedText(ride) || "(no served request)"} | ${rideFlags(board, ride).join(" ")}`;
}

function describeSuggestion(board: Board, s: Suggestion, index: number): string {
  const w = (win: { start: number; end: number }) => `${t(slotToIso(win.start, board.weekStartMs))}-${t(slotToIso(win.end, board.weekStartMs))}`;
  const base = `    ${index + 1}. ${s.kind}`;
  switch (s.kind) {
    case "shiftWithinFlex": return `${base} car=${board.carName(s.carId)} window=${w(s.window)} (${s.reasonCode})`;
    case "shiftBeyondFlex": return `${base} car=${board.carName(s.carId)} window=${w(s.window)} shift=${s.shift.departureMin}/${s.shift.returnMin}min (${s.reasonCode})`;
    case "merge": return `${base} host=${short(s.hostRideId)} leg=${s.leg} window=${w(s.window)} detour=${s.detourMinutes}min/${s.detourKm}km${s.boardAtLocationId ? ` board@${board.destName(s.boardAtLocationId)}` : ""} (${s.reasonCode})`;
    case "convertToRoundTrip": return `${base} car=${board.carName(s.carId)} window=${w(s.window)}`;
    case "chauffeur": return `${base} leg=${s.leg} car=${board.carName(s.carId)} window=${w(s.window)} volunteers=${s.volunteerCandidateMemberIds.length}`;
    case "changeOrigin": return `${base} origin=${board.destName(s.originId)} car=${board.carName(s.carId)}`;
    case "useAlternative": return `${base} car=${board.carName(s.carId)}${s.returnCarId ? ` return-car=${board.carName(s.returnCarId)}` : ""} depart=${t(slotToIso(s.departSlot, board.weekStartMs))}${s.returnSlot != null ? ` back=${t(slotToIso(s.returnSlot, board.weekStartMs))}` : ""} (${s.reasonCode})`;
    case "externalHint": return `${base} hint=${s.hint}`;
    case "splitLegs": return `${base} out(${s.outbound.carMode}${s.outbound.hostRideId ? ` host ${short(s.outbound.hostRideId)}` : ""}) return(${s.return.carMode}${s.return.hostRideId ? ` host ${short(s.return.hostRideId)}` : ""})`;
    default: return `${base} (${s.reasonCode})`;
  }
}

async function activePolicy(board: Board) {
  const policy = await api.fetchActivePolicy(board.scope.departmentId);
  if (!policy) throw new Error("department has no active policy");
  return policy;
}

// --- session / scope ------------------------------------------------------------------------

let OUT = "";
let SADRAN_EMAIL = "sadran";
async function open(args: Args): Promise<{ scope: Scope; board: Board }> {
  OUT = outDir(args);
  const fromFile = sadranFromPersonas(OUT);
  const email = flag(args, "email") ?? process.env.QA_SADRAN_EMAIL ?? fromFile?.email ?? "sadran@nevo.local";
  const password = flag(args, "password") ?? process.env.QA_SADRAN_PASSWORD ?? fromFile?.password ?? DEMO_PASSWORD;
  await signIn({ email, password });
  SADRAN_EMAIL = email;
  const scope = await resolveScope(args, fromFile ?? {});
  return { scope, board: await loadBoard(scope) };
}

// --- commands -------------------------------------------------------------------------------

async function cmdWeek(board: Board): Promise<void> {
  const { scope } = board;
  const byStatus = new Map<string, number>();
  for (const r of board.requests) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  const propByStatus = new Map<string, number>();
  for (const p of board.proposals) propByStatus.set(p.status, (propByStatus.get(p.status) ?? 0) + 1);
  console.log(`WEEK ${scope.weekStart} dept="${scope.departmentName}" (${scope.departmentId}) phase=${board.week?.phase} close_at=${board.week?.close_at ?? "-"}`);
  console.log(`requests: ${board.requests.length} ${[...byStatus].map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`rides: ${board.rides.length} | proposals: ${board.proposals.length} ${[...propByStatus].map(([k, v]) => `${k}=${v}`).join(" ")} | cars: ${board.cars.length}`);
  let readiness: api.PublicationDay[] = [];
  try { readiness = await api.fetchPublicationReadiness(scope.departmentId, scope.weekStart); } catch (e) { console.log(`(publication readiness unavailable: ${(e as Error).message})`); }
  console.log("DAY        rides unmet drafts | readiness: requests unresolved incomplete pending draftProp noDriver conflicts ready published");
  for (let i = 0; i < 7; i++) {
    const day = new Date(Date.parse(`${scope.weekStart}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
    const rides = board.rides.filter((r) => dayOf(r.starts_at) === day).length;
    const unmet = unmetItemsOf(board, day).length;
    const drafts = board.proposals.filter((p) => p.status === "draft" && board.requests.some((r) => r.id === p.request_id && dayOf(requestStart(r)) === day)).length;
    const rd = readiness.find((d) => d.day === day);
    console.log(`${day} ${String(rides).padStart(5)} ${String(unmet).padStart(5)} ${String(drafts).padStart(6)} | ${rd ? `${rd.requestCount} ${rd.unresolvedRequests} ${rd.incompleteAssignments} ${rd.pendingProposals} ${rd.draftProposals} ${rd.missingDriverRides} ${rd.conflictRides} ${rd.ready ? "READY" : "not-ready"} ${rd.published ? "published" : "-"}` : "-"}`);
  }
}

async function cmdDay(board: Board, day: string): Promise<void> {
  const policy = await api.fetchActivePolicy(board.scope.departmentId);
  const output = policy ? await solverPreview(board, policy).catch((e) => { console.log(`(solver preview failed: ${(e as Error).message})`); return null; }) : null;
  console.log(`DAY ${day} week=${board.scope.weekStart} phase=${board.week?.phase} home=${board.destName(board.scope.homeDestinationId)}`);
  const dayRides = board.rides.filter((r) => dayOf(r.starts_at) === day && r.status !== "cancelled");
  const cars = board.cars.filter((c) => c.status === "active" || dayRides.some((r) => r.car_id === c.id));
  const idle: string[] = [];
  for (const car of cars) {
    const rides = dayRides.filter((r) => r.car_id === car.id).sort((a, b) => (a.starts_at ?? "").localeCompare(b.starts_at ?? "") || (a.id ?? "").localeCompare(b.id ?? ""));
    const startsAt = board.carStart[car.id]?.locationId;
    const meta = `seats ${seatsOfCar(board, car.id)}${car.base_location_id && car.base_location_id !== board.scope.homeDestinationId ? ` base=${board.destName(car.base_location_id)}` : ""}${startsAt && startsAt !== board.scope.homeDestinationId ? ` week-start-at=${board.destName(startsAt)}` : ""}${car.type !== "shared" ? ` ${car.type}` : ""}`;
    if (!rides.length) { idle.push(`${car.name}(${short(car.id)}; ${meta})`); continue; }
    console.log(`CAR ${car.name} (${short(car.id)}; ${meta})`);
    for (const ride of rides) console.log(rideLine(board, ride));
    const away = board.weekEndAwayByCarId.get(car.id);
    if (away && day === dayOf(new Date(board.weekStartMs + 6 * 86_400_000 + 3_600_000).toISOString())) console.log(`  WARN car ends the week away at ${board.destName(away.locationId)}`);
  }
  console.log(`IDLE CARS: ${idle.join(", ") || "(none)"}`);
  const maint = board.maintenance.filter((m) => dayOf(m.starts_at) === day || dayOf(m.ends_at) === day);
  for (const m of maint) console.log(`MAINTENANCE ${board.carName(m.car_id)} ${t(m.starts_at)}-${t(m.ends_at)}`);

  const dayPlacements = board.draftPlacements.filter((p) => dayOf(p.startsAt) === day);
  if (dayPlacements.length) {
    console.log("DRAFT PLACEMENTS (unsent proposals drawn as their result)");
    for (const p of dayPlacements) console.log(`  draft ${short(p.proposalId)} ${p.type} req=${short(p.requestId)} car=${board.carName(p.carId)} ${t(p.startsAt)}-${t(p.endsAt)}${p.replacesRideId ? ` replaces ride ${short(p.replacesRideId)}` : ""}`);
  }
  const unmet = unmetItemsOf(board, day, output);
  console.log(`UNMET (${unmet.length})`);
  for (const item of unmet) {
    const r = item.request;
    const route = `${r.origin_id ? board.destName(r.origin_id) : r.origin_text ?? "home"}->${r.destination_resolved_name ?? "?"}`;
    const stops = (r.stops ?? []).map((s) => `${s.leg}:${s.place?.name ?? s.place_text}`).join(",");
    const drop = tripTypeOf(r) === "drop_off";
    console.log(`  req ${short(r.id)}${item.leg ? `:${item.leg}` : ""} ${r.requester_full_name ?? "?"} ${tripTypeOf(r)}${r.trip_shape !== "round_trip" ? `(${r.trip_shape})` : ""} ${route}${stops ? ` stops[${stops}]` : ""} dep ${t(r.depart_at)} ${flexText(r.flex_depart_early, r.flex_depart_late)}${r.return_at ? ` ret ${t(r.return_at)} ${flexText(r.flex_return_early, r.flex_return_late)}` : ""} ${r.adults}a${r.child_seats ? `+${r.child_seats}cs` : ""}${r.boosters ? `+${r.boosters}b` : ""}${r.requester_does_not_drive ? " non-driver" : ""}${r.driving_companion_ids.length ? " has-driving-companion" : ""}${r.preferred_car_name ? ` prefers=${r.preferred_car_name}` : ""} status=${r.status}${r.is_late ? " LATE" : ""}${drop ? " (needs a driver)" : ""}${r.series_id ? " series" : ""}${r.notes ? ` notes="${r.notes}"` : ""}${item.pendingProposalId ? ` proposal-pending=${short(item.pendingProposalId)}` : ""}`);
    const planned = output?.assignments.filter((a) => a.source === "solver" && a.servedRequestIds.includes(r.id)) ?? [];
    for (const a of planned) console.log(`    autofill would place: car ${board.carName(a.carId)} ${t(slotToIso(a.window.start, board.weekStartMs))}-${t(slotToIso(a.window.end, board.weekStartMs))} (${a.reasonCode})`);
    if (item.solverInfo) {
      console.log(`    reason: ${item.solverInfo.reasonCode} ${item.solverInfo.reason}`);
      item.solverInfo.suggestions.slice(0, 6).forEach((s, i) => console.log(describeSuggestion(board, s, i)));
    }
  }
  const props = board.proposals.filter((p) => ["draft", "sent", "accepted", "declined"].includes(p.status) && board.requests.some((r) => r.id === p.request_id && dayOf(requestStart(r)) === day));
  console.log(`PROPOSALS (${props.length})`);
  for (const p of props) {
    const req = board.requests.find((r) => r.id === p.request_id);
    console.log(`  prop ${short(p.id)} ${p.type} ${p.status} req=${short(p.request_id)} (${req?.requester_full_name ?? "?"}) ride=${short(p.ride_id)}${p.answered_at ? ` answered=${p.answered_via}` : ""} v${p.version}`);
  }
  if (output && output.warnings.length) for (const w of output.warnings.slice(0, 5)) console.log(`SOLVER WARNING ${w.code}: ${w.message}`);
}

async function cmdRequests(board: Board, args: Args): Promise<void> {
  const status = flag(args, "status");
  const day = args.pos[0];
  const rows = board.boardRequests.filter((r) => (!status || r.status === status) && (!day || dayOf(requestStart(r)) === day));
  for (const r of rows.sort((a, b) => (a.depart_at ?? "").localeCompare(b.depart_at ?? ""))) {
    console.log(`req ${short(r.id)} ${dayOf(requestStart(r))} ${r.requester_full_name ?? "?"} ${tripTypeOf(r)} ${r.origin_id ? board.destName(r.origin_id) : r.origin_text ?? "home"}->${r.destination_resolved_name ?? "?"} dep ${t(r.depart_at)} ret ${t(r.return_at)} ${r.adults}a status=${r.status}`);
  }
  console.log(`(${rows.length} requests)`);
}

async function applyOutput(board: Board, mode: "remaining" | "full", args: Args): Promise<void> {
  const policy = await activePolicy(board);
  const context = await gatherSolverContext({ departmentId: board.scope.departmentId, weekStart: board.scope.weekStart, homeDestinationId: board.scope.homeDestinationId,
    policy: { policyId: policy.policyId, policyVersionId: policy.policyVersionId, versionNo: policy.versionNo, rules: policy.rules, settings: policy.settings }, mode });
  const day = flag(args, "day");
  if (day) restrictInputToDay(context.input, day);
  const startedAtMs = nowMs();
  const output = runSolve(context.input);
  const finishedAtMs = nowMs();
  if (mode === "full") {
    const diff = computeFullResolveDiff(context, output);
    console.log(`full re-solve would replace ${diff.changedOrRemovedRides.length} unpinned rides; ${diff.requestsLosingAssignment} requests would lose their assignment`);
  }
  if (has(args, "dry-run")) {
    console.log(`dry run (nothing applied): solver would serve=${output.stats.served} unmet=${output.stats.unmet} needsDriver=${output.stats.needsDriver} relocations=${output.stats.relocations}`);
    return;
  }
  const payload = buildApplyPayload({ output, weekStartMs: context.weekStartMs, policyVersionId: context.policyVersionId, startedAtMs, finishedAtMs,
    inputHash: hashSolverInput(context.input), requestsById: context.requestsById, mode });
  const summary = await api.applySolverResult(board.scope.departmentId, board.scope.weekStart, payload as unknown as Json);
  console.log(`applied (${mode}${day ? ` day ${day}` : ""}): inserted=${summary.inserted} deleted=${summary.deleted} unchanged=${summary.unchanged} unassigned=${summary.unassigned_requests.length}${summary.skippedSeries?.length ? ` skippedSeries=${summary.skippedSeries.length} (${summary.skippedSeries.map((s) => s.reason).join(",")})` : ""}`);
  console.log(`solver: served=${output.stats.served} unmet=${output.stats.unmet} needsDriver=${output.stats.needsDriver} relocations=${output.stats.relocations}${output.stats.budgetExhausted ? " BUDGET-EXHAUSTED" : ""}`);
}

async function cmdPlace(board: Board, args: Args): Promise<void> {
  const [reqToken, carToken, time] = [need(args.pos[0], "<requestId>"), need(args.pos[1], "<car>"), need(args.pos[2], "<HH:MM>")];
  const request = resolveRequest(board, reqToken);
  const car = resolveCar(board, carToken);
  const wantLeg = flag(args, "leg") as "out" | "return" | undefined;
  const anchorDay = dayOf(requestStart(request)) || dayOf(request.depart_at);
  const ctx = dropCtxOf(board, anchorDay);
  let item = ctx.unmetItems.find((i) => i.request.id === request.id && (!wantLeg || i.leg === wantLeg) && (!(isDropOffWithPickup(request)) || wantLeg || i.leg === "out" || !i.leg));
  if (!item && isDropOffWithPickup(request) && wantLeg) {
    // the pickup card is anchored on the return day
    const returnCtx = dropCtxOf(board, dayOf(request.return_at));
    item = returnCtx.unmetItems.find((i) => i.request.id === request.id && i.leg === wantLeg);
  }
  if (!item) throw new UsageError(`request ${short(request.id)} is not an unmet card (status=${request.status}${isDropOffWithPickup(request) ? `; legs covered out=${coveredLegs(board.rides, request.id).out} return=${coveredLegs(board.rides, request.id).return}` : ""})`);
  const day = dayOf(requestStart(item.request));
  const dctx = dropCtxOf(board, day);
  const minutes = minutesOfDay(day, time);
  const req = item.request;
  const window0 = unmetCandidateWindow(dctx, item, minutes);
  if (!window0) throw new UsageError("invalid window (outside the request's day or past 23:59)");
  const connects = connectsOtherLeg(dctx, item, car.id);
  const window = unmetCandidateWindow(dctx, item, minutes, !connects);
  if (!window) throw new UsageError("invalid window");
  // R4B11: the board refuses a private car first (only its owner places requests there), whatever else is wrong.
  if (privateCarBlocks(dctx, car.id, req.requester_id) && !has(args, "force")) throw new UsageError("the board would refuse this drop: private car - only its owner places requests on it (private_car_owner_only)");
  const problems: string[] = [];
  if (unavailable(dctx, car.id, window.startsAt, window.endsAt)) problems.push("car inactive or in maintenance then");
  if (!seatsFit(dctx, car.id, connects ? { adults: req.adults, childSeats: req.child_seats, boosters: req.boosters } : unmetRequestPassengers(req))) problems.push("seats do not fit");
  const originId = req.origin_id ?? board.scope.homeDestinationId;
  if (!connects && originId && originMismatch(dctx, car.id, originId, window.startsAt)) problems.push(`car is at ${board.destName(carLocationAt(dctx, car.id, window.startsAt))} then, request starts at ${board.destName(originId)}`);
  if (!connects && tripTypeOf(req) === "one_way" && req.destination_id && strandsNextRide(dctx, car.id, req.destination_id, window.endsAt)) problems.push("would strand the car's next ride (it starts elsewhere)");
  if (!isUnmetDropValid(dctx, item, car.id, minutes) && !problems.length) problems.push("overlaps another ride on the car");
  if (problems.length && !has(args, "force")) throw new UsageError(`the board would refuse this drop: ${problems.join("; ")} (use --force to send it to the server anyway)`);
  const placement = unmetPlacement(dctx, req, car.id, window.startsAt);
  if (!placement) throw new UsageError("cannot place: one-way request without a destination place");
  if (!requestWithinFlex(req, window.startsAt, window.endsAt)) {
    throw new UsageError(`window ${t(window.startsAt)}-${t(window.endsAt)} is outside the request's flexibility: send a shift proposal instead: propose ${short(request.id)} shift --car ${JSON.stringify(car.name)} --depart ${t(window.startsAt)}${req.return_at ? ` --return ${t(window.endsAt)}` : ""}`);
  }
  const rideId = await api.editRide({
    department_id: board.scope.departmentId, week_start: board.scope.weekStart, car_id: car.id, starts_at: window.startsAt, ends_at: window.endsAt,
    origin_id: placement.originId, destination_id: placement.destinationId, driver_id: placement.driverIsRequester ? req.requester_id : null,
    needs_driver: !placement.driverIsRequester, allow_conflict: true, is_pinned: true, pin_reason: "SADRAN_MANUAL",
    served: [{ request_id: req.id, ...placement.served }],
  });
  console.log(`placed ${req.requester_full_name} on ${car.name} ${t(window.startsAt)}-${t(window.endsAt)} -> ride ${short(rideId)}${placement.driverIsRequester ? "" : " (chauffeur ride, needs a driver)"}${connects ? " (connected to the other leg)" : ""}`);
}

async function cmdMove(board: Board, args: Args): Promise<void> {
  const ride = resolveRide(board, need(args.pos[0], "<rideId>"));
  if (!ride.id || !ride.starts_at || !ride.ends_at || !ride.car_id || !ride.origin_id || !ride.destination_id) throw new UsageError("ride lacks times/car/places");
  const carId = flag(args, "car") ? resolveCar(board, flag(args, "car")!).id : ride.car_id;
  const day = dayOf(ride.starts_at);
  const dctx = dropCtxOf(board, day);
  const startMin = flag(args, "start") ? minutesOfDay(day, flag(args, "start")!) : Math.round((Date.parse(ride.starts_at) - Date.parse(minutesIso(dctx, 0))) / 60_000);
  const oldDuration = Math.round((Date.parse(ride.ends_at) - Date.parse(ride.starts_at)) / 60_000);
  const endMin = flag(args, "end") ? minutesOfDay(day, flag(args, "end")!) : startMin + oldDuration;
  const newEnd = endMin === 1439 ? 1439 : Math.round(endMin / 15) * 15;
  if (startMin < 0 || newEnd > 1439 || newEnd <= startMin) throw new UsageError("invalid window");
  const newStartsAt = minutesIso(dctx, startMin);
  const newEndsAt = minutesIso(dctx, newEnd);
  if (unavailable(dctx, carId, newStartsAt, newEndsAt)) throw new UsageError("car inactive or in maintenance then");
  if (carId !== ride.car_id && !seatsFit(dctx, carId, passengersOf(ride))) throw new UsageError("seats do not fit on that car");
  const served = servedOf(ride);
  const servedRequests = served.map((e) => board.boardRequests.find((r) => r.id === e.request_id)).filter((r): r is NonNullable<typeof r> => !!r);
  const withinFlex = servedRequests.every((r) => requestWithinFlex(r, newStartsAt, newEndsAt));
  const hiddenIds = draftHiddenRideIds(board);
  const others = board.rides.filter((r) => r.id !== ride.id && !(r.id && hiddenIds.has(r.id)) && r.car_id === carId && r.starts_at && r.ends_at && r.status !== "cancelled");
  const collision = others.some((o) => Date.parse(newStartsAt) < Date.parse(o.ends_at!) && Date.parse(o.starts_at!) < Date.parse(newEndsAt));
  const driverEntry = served.find((s) => s.role === "driver") ?? served[0];
  if (!withinFlex && !(collision && ride.status !== "draft")) {
    const hint = driverEntry?.request_id ? `propose ${short(driverEntry.request_id)} shift --ride ${short(ride.id)} --car ${JSON.stringify(board.carName(carId))} --depart ${t(newStartsAt)} --return ${t(newEndsAt)}` : "(no served request to propose to)";
    if (!has(args, "propose") && !has(args, "draft")) throw new UsageError(`beyond the member's flexibility: needs a shift proposal: ${hint} (or re-run move with --propose [--draft])`);
    const prefill: ComposerPrefill = { requestId: driverEntry!.request_id!, rideId: ride.id, type: "shift", payload: { car_id: carId, depart_at: newStartsAt, return_at: newEndsAt, ride_id: ride.id } };
    await createProposalFrom(board, prefill, has(args, "draft"));
    return;
  }
  await api.editRide({
    id: ride.id, department_id: board.scope.departmentId, week_start: board.scope.weekStart, car_id: carId, starts_at: newStartsAt, ends_at: newEndsAt,
    origin_id: ride.origin_id, destination_id: ride.destination_id, driver_id: ride.driver_id, needs_driver: !!ride.needs_driver, notes: ride.notes ?? undefined,
    is_pinned: true, allow_conflict: true, pin_reason: ride.pin_reason ?? "SADRAN_MANUAL", served: servedToEditRideLegs(served),
  }, ride.version ?? undefined);
  console.log(`moved ride ${short(ride.id)} to ${board.carName(carId)} ${t(newStartsAt)}-${t(newEndsAt)}${collision ? " (OVERLAPS another ride: planning conflict flagged)" : ""}`);
}

async function createProposalFrom(board: Board, prefill: ComposerPrefill, draft: boolean): Promise<string> {
  const templates = await fetchWhatsappTemplates();
  const { data: me } = await supabase.auth.getUser();
  const profile = me.user ? (await fetchProfilesByIds([me.user.id]))[0] : undefined;
  // R5B5: like the board's draft path, a merge's text reads the server's merge_preview (the one source of the times).
  const mergeRequest = board.boardRequests.find((r) => r.id === prefill.requestId);
  const serverMerge = prefill.type === "merge" && prefill.rideId && mergeRequest
    ? await api.fetchMergePreview(prefill.rideId, prefill.requestId, mergePayloadLeg(prefill.payload, mergeRequest)).catch(() => null) : null;
  const built = buildDraftInput(prefill, {
    requests: board.boardRequests, rides: board.rides, templates, destinations: board.destinations, cars: board.cars,
    sadranName: profile?.full_name ?? "", homeDestinationId: board.scope.homeDestinationId, route: board.routeCtx, serverMerge,
  });
  if (!built.ok) throw new UsageError("cannot build this proposal (missing data: a merge needs a driven host ride; a shift needs a time or place change)");
  const pending = board.proposals.find((p) => p.request_id === prefill.requestId && p.status === "sent");
  const id = await api.createProposal(built.input);
  if (draft) { console.log(`draft proposal ${short(id)} (${prefill.type}) created; send it with: send ${short(id)}`); return id; }
  const sent = await api.sendProposal(id, [], pending ? { id: pending.id, version: pending.version } : undefined);
  printCarConflicts(sent);
  console.log(`proposal ${short(id)} (${prefill.type}) sent to ${Object.keys(sent.party_tokens).length || 1} party/ies${pending ? ` (replaced ${short(pending.id)})` : ""}`);
  return id;
}

/** R10B6/R10F1: the board asks the Sadran before sending a proposal whose car another pending proposal holds; the CLI prints the warning and sends. */
function printCarConflicts(sent: api.SendProposalResult): void {
  for (const c of sent.car_conflicts ?? []) {
    console.log(`warning: ${c.requester_name}'s ${c.type} proposal ${short(c.proposal_id)} already holds ${c.car_name} ${c.from_at} - ${c.to_at}; sent anyway (if both are accepted the later one is withdrawn as stale)`);
  }
}

async function cmdMerge(board: Board, args: Args): Promise<void> {
  const request = resolveRequest(board, need(args.pos[0], "<requestId>"));
  const host = resolveRide(board, need(args.pos[1], "<rideId>"));
  const leg = (flag(args, "leg") ?? (request.trip_shape === "one_way_from" ? "return" : "out")) as MergeLeg;
  // REQ §13.100 (c): a request may be merged into a ride that still needs a driver (it keeps waiting for a volunteer).
  if (host.needs_driver || !host.driver_id) console.log(`note: host ride ${short(host.id)} still needs a driver; the guest joins it and the ride keeps waiting for a volunteer`);
  const invalid = mergeInvalidReason(host, request, leg, board.routeCtx);
  if (invalid) throw new UsageError(`merge not valid: ${invalid}`);
  await createProposalFrom(board, { requestId: request.id, rideId: host.id, type: "merge", payload: mergePayload(host.id as string, leg) }, has(args, "draft"));
}

async function cmdUnmerge(board: Board, args: Args): Promise<void> {
  const ride = resolveRide(board, need(args.pos[0], "<rideId>"));
  const request = resolveRequest(board, need(args.pos[1], "<requestId>"));
  await api.unmergeRequest(ride.id as string, request.id, ride.version ?? 0);
  console.log(`unmerged ${request.requester_full_name} from ride ${short(ride.id)}; request is unmet again`);
}

async function cmdTripType(board: Board, args: Args): Promise<void> {
  const request = resolveRequest(board, need(args.pos[0], "<requestId>"));
  const type = need(args.pos[1], "<round_trip|one_way|drop_off>") as "round_trip" | "one_way" | "drop_off";
  const res = await api.setRequestTripType(request.id, type, request.version);
  console.log(`trip type -> ${type}: status=${res.status} changed=${res.changed}${res.rideId ? ` ride=${short(res.rideId)}` : ""}${res.restoredReturnAt ? ` restoredReturn=${t(res.restoredReturnAt)}` : ""}${res.defaultedReturnAt ? ` defaultedReturn=${t(res.defaultedReturnAt)}` : ""}`);
}

async function cmdEditRoute(board: Board, args: Args): Promise<void> {
  const token = need(args.pos[0], "<rideId|requestId>");
  const all = [...board.rides.flatMap((r) => (r.id ? [r.id] : [])), ...board.requests.map((r) => r.id)];
  const id = resolveId(token, all, "ride or request");
  let ride = board.rides.find((r) => r.id === id);
  if (!ride) {
    ride = board.rides.find((r) => r.status !== "cancelled" && servedOf(r).some((e) => e.request_id === id));
    if (!ride) throw new UsageError("that request has no ride yet; edit its route with propose shift or change it on the request");
  }
  const served = servedOf(ride);
  const base = served.find((e) => e.role === "driver") ?? served[0];
  const request = base ? board.boardRequests.find((r) => r.id === base.request_id) : undefined;
  const initial = initialRouteEditValues({
    request: request ?? null, stops: (base?.stops ?? []) as never,
    ride: { origin_id: ride.origin_id, origin_name: ride.origin_name, destination_id: ride.destination_id, destination_name: ride.destination_name },
    homeId: board.scope.homeDestinationId, placeName: (placeId) => board.destinations.find((d) => d.id === placeId)?.name,
  });
  const values: RouteEditValues = { ...initial,
    origin: flag(args, "origin") ? resolvePlace(board, flag(args, "origin")!) : initial.origin,
    destination: flag(args, "dest") ? resolvePlace(board, flag(args, "dest")!) : initial.destination,
    outStops: has(args, "clear-stops") ? [] : flagAll(args, "stop").length ? flagAll(args, "stop").map((s) => resolvePlace(board, s)) : initial.outStops,
    returnStops: has(args, "clear-stops") ? [] : flagAll(args, "return-stop").length ? flagAll(args, "return-stop").map((s) => resolvePlace(board, s)) : initial.returnStops };
  if (!routeEditChanged(initial, values)) throw new UsageError("nothing changed (give --origin/--dest/--stop/--return-stop/--clear-stops)");
  if (base?.request_id) {
    await createProposalFrom(board, { requestId: base.request_id, rideId: ride.id as string, type: "shift", payload: routeEditPayload(ride.id as string, values) }, has(args, "draft"));
    return;
  }
  const places = reservationRoutePlaces(values);
  if (!places) throw new UsageError("a reservation's route takes two list places only");
  await api.editRide({ id: ride.id as string, department_id: board.scope.departmentId, week_start: board.scope.weekStart, car_id: ride.car_id as string,
    starts_at: ride.starts_at as string, ends_at: ride.ends_at as string, origin_id: places.originId, destination_id: places.destinationId, driver_id: ride.driver_id,
    needs_driver: !!ride.needs_driver, notes: ride.notes ?? undefined, is_pinned: !!ride.is_pinned, pin_reason: ride.pin_reason, allow_conflict: true, served: servedToEditRideLegs(served) }, ride.version ?? undefined);
  console.log(`reservation ${short(ride.id)} route -> ${board.destName(places.originId)}->${board.destName(places.destinationId)}`);
}

async function cmdPropose(board: Board, args: Args): Promise<void> {
  const request = resolveRequest(board, need(args.pos[0], "<requestId>"));
  const type = need(args.pos[1], "shift|origin|alternative|deny|external") as "shift" | "origin" | "alternative" | "deny" | "external";
  const draft = has(args, "draft");
  const day = dayOf(requestStart(request)) || board.scope.weekStart;
  const rideId = flag(args, "ride") ? resolveRide(board, flag(args, "ride")!).id ?? null : null;
  const payload: Record<string, unknown> = {};
  if (type === "shift") {
    const day0 = flag(args, "day") ?? day;
    const startsAt = flag(args, "depart") ? instantAt(day0, flag(args, "depart")!) : request.depart_at;
    const endsAt = flag(args, "return") ? instantAt(day0, flag(args, "return")!) : request.return_at;
    if (rideId) payload.ride_id = rideId;
    // R5B3 (QA run 6): a drop-off shift given ONE time (or --leg) is a one-leg shift, as the board sends it - it
    // carries the car and that leg only, so the other leg stays where it is.
    const oneLegArg = flag(args, "leg") as "out" | "return" | undefined;
    const oneLeg = tripTypeOf(request) === "drop_off" ? (oneLegArg ?? (flag(args, "return") && !flag(args, "depart") ? "return" : flag(args, "depart") && !flag(args, "return") ? "out" : undefined)) : undefined;
    if (oneLeg && flag(args, "car")) {
      payload.car_id = resolveCar(board, flag(args, "car")!).id;
      payload.leg = oneLeg;
      if (oneLeg === "return") payload.return_at = endsAt; else payload.depart_at = startsAt;
    } else if (flag(args, "car") && startsAt) {
      // Same payload the board builds for an unmet drop outside the request's flexibility (places from the placement).
      const car = resolveCar(board, flag(args, "car")!);
      const dctx = dropCtxOf(board, dayOf(requestStart(request)) || day0);
      const item = dctx.unmetItems.find((i) => i.request.id === request.id);
      const minutes = Math.round((Date.parse(startsAt) - Date.parse(minutesIso(dctx, 0))) / 60_000);
      const window = flag(args, "return") || tripTypeOf(request) === "round_trip" ? (endsAt ? { startsAt, endsAt } : null) : item ? unmetCandidateWindow(dctx, item, minutes) : null;
      const placement = window ? unmetPlacement(dctx, request, car.id, window.startsAt) : null;
      if (!window || !placement) throw new UsageError("cannot build the shift window/places for that car (give --depart and, for a round trip, --return)");
      Object.assign(payload, unmetShiftPayload(request, car.id, window, placement));
    } else {
      if (flag(args, "car")) payload.car_id = resolveCar(board, flag(args, "car")!).id;
      if (flag(args, "depart")) payload.depart_at = startsAt;
      if (flag(args, "return")) payload.return_at = endsAt;
    }
  } else if (type === "origin") {
    payload.origin_id = (resolvePlace(board, need(flag(args, "origin"), "--origin") as string) as { presetId: string }).presetId;
    payload.car_id = resolveCar(board, need(flag(args, "car"), "--car") as string).id;
  } else if (type === "alternative") {
    // REQ §13.112 (a): the request's own plan B placed on a car: --depart is when the member leaves home, --return when they are
    // back (only with a pickup). `unmet` lists a `useAlternative` suggestion with the numbers to use.
    payload.car_id = resolveCar(board, need(flag(args, "car"), "--car") as string).id;
    if (flag(args, "return-car")) payload.return_car_id = resolveCar(board, flag(args, "return-car")!).id;
    payload.depart_at = instantAt(day, need(flag(args, "depart"), "--depart") as string);
    if (flag(args, "return")) payload.return_at = instantAt(day, flag(args, "return")!);
  } else if (type === "deny" || type === "external") {
    if (flag(args, "reason")) payload.reason = flag(args, "reason");
    if (type === "external") payload.hint = flag(args, "hint") ?? "cab";
  }
  await createProposalFrom(board, { requestId: request.id, rideId, type, payload }, draft);
}

async function cmdSend(board: Board, args: Args): Promise<void> {
  const proposal = board.proposals.find((p) => p.id === resolveId(need(args.pos[0], "<proposalId>"), board.proposals.map((p) => p.id), "proposal"))!;
  const pending = board.proposals.find((p) => p.request_id === proposal.request_id && p.status === "sent" && p.id !== proposal.id);
  const sent = await api.sendProposal(proposal.id, [], pending ? { id: pending.id, version: pending.version } : undefined);
  printCarConflicts(sent);
  console.log(`proposal ${short(proposal.id)} sent to ${Object.keys(sent.party_tokens).length || 1} party/ies${pending ? ` (replaced ${short(pending.id)})` : ""}`);
}

async function cmdProposals(board: Board): Promise<void> {
  for (const p of board.proposals.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const parties = await api.fetchProposalParties(p.id);
    const req = board.requests.find((r) => r.id === p.request_id);
    console.log(`prop ${short(p.id)} ${p.type} ${p.status} req=${short(p.request_id)} (${req?.requester_full_name ?? "?"}) ride=${short(p.ride_id)} v${p.version}${p.answered_at ? ` answered=${p.answered_via}` : ""}${parties.length ? ` parties[${parties.map((x) => `${short(x.profile_id)}:${x.response}`).join(",")}]` : ""}`);
  }
}

async function cmdApply(args: Args, board: Board): Promise<void> {
  const proposal = board.proposals.find((p) => p.id === resolveId(need(args.pos[0], "<proposalId>"), board.proposals.map((p) => p.id), "proposal"))!;
  if (proposal.status === "applied") { console.log(`proposal ${short(proposal.id)} is already applied (an accepted answer applies it automatically)`); return; }
  if (proposal.status !== "accepted") throw new UsageError(`proposal is ${proposal.status}; only an accepted proposal can be applied`);
  const rideId = await api.applyProposal(proposal.id);
  console.log(`proposal ${short(proposal.id)} applied -> ride ${short(rideId)}`);
}

async function cmdReserve(board: Board, args: Args): Promise<void> {
  const car = resolveCar(board, need(args.pos[0], "<car>"));
  const day = need(args.pos[1], "<day>");
  const [from, to] = need(args.pos[2], "<HH:MM-HH:MM>").split("-");
  const note = args.pos.slice(3).join(" ");
  if (!from || !to || !note) throw new UsageError("reserve <car> <day> <HH:MM-HH:MM> <note>");
  const rideId = await api.editRide({ department_id: board.scope.departmentId, week_start: board.scope.weekStart, car_id: car.id, starts_at: instantAt(day, from), ends_at: instantAt(day, to),
    origin_id: board.scope.homeDestinationId, destination_id: board.scope.homeDestinationId, driver_id: null, notes: note, is_pinned: true, pin_reason: "SADRAN_MANUAL", served: [] });
  console.log(`reserved ${car.name} ${day} ${from}-${to} "${note}" -> ride ${short(rideId)}`);
}

/** REQ §13.103 b: "the car was moved from A to B" — decides where the car is from then on (`mark_car_move`). */
async function cmdCarMove(board: Board, args: Args): Promise<void> {
  const car = resolveCar(board, need(args.pos[0], "<car>"));
  const from = resolvePlace(board, need(args.pos[1], "<from>"));
  const to = resolvePlace(board, need(args.pos[2], "<to>"));
  if (!("presetId" in from) || !("presetId" in to)) throw new UsageError("car-move needs list places for <from> and <to>");
  const at = need(args.pos[3], "<HH:MM>");
  const day = flag(args, "day") ?? board.scope.weekStart;
  const minutes = Number(flag(args, "minutes") ?? 60);
  const { data, error } = await supabase.rpc("mark_car_move", { p_car_id: car.id, p_from_place: from.presetId, p_to_place: to.presetId, p_at: instantAt(day, at), p_minutes: minutes });
  if (error) throw new UsageError(`car-move refused: ${error.message}`);
  console.log(`car ${car.name} moved ${from.name} -> ${to.name} ${day} ${at} (${minutes} min) -> ride ${short(data)}`);
}

async function cmdPublish(board: Board, args: Args): Promise<void> {
  const days = flag(args, "days")?.split(",");
  const publishedDays = async () => (await api.fetchPublicationReadiness(board.scope.departmentId, board.scope.weekStart)).filter((d) => d.published).map((d) => d.day);
  const before = new Set(await publishedDays().catch(() => [] as string[]));
  const id = await publishWithScores(board.scope.departmentId, board.scope.weekStart, { days, allowUnanswered: has(args, "allow-unanswered") });
  // Report what was actually published (the RPC publishes every ready day when no --days is given), not what was asked for.
  const after = await publishedDays().catch(() => null);
  const newly = after ? after.filter((d) => !before.has(d)) : null;
  console.log(`published ${newly ? (newly.length ? `days ${newly.join(",")}` : "no new days (nothing was ready)") : "(days unknown: readiness unavailable)"}${after ? ` | published now: ${after.join(",") || "-"}` : ""} | siddur version ${id}`);
}

/** Assign (or clear with `none`) the driver of a chauffeur / needs-driver ride, keeping everything else on it. */
async function cmdAssignDriver(board: Board, args: Args): Promise<void> {
  const ride = resolveRide(board, need(args.pos[0], "<rideId>"));
  if (!ride.id || !ride.starts_at || !ride.ends_at || !ride.car_id || !ride.origin_id || !ride.destination_id) throw new UsageError("ride lacks times/car/places");
  const who = need(args.pos[1], "<member name|email-prefix|id|none>");
  const members = await loadMembers(board);
  const driver = who === "none" ? null : pickMember(members, who);
  // R5B7: the board's driver picker path (`set_ride_driver`) - it notifies the driver and the passengers.
  await api.setRideDriver(ride.id, driver?.id ?? null, ride.version ?? 0);
  console.log(`ride ${short(ride.id)} driver: ${driver ? `${driver.name} (${short(driver.id)})` : "(none, needs a driver)"}`);
}

/** `add-passengers <ride> <name>[:adult|child_seat|booster]...` - the siddur "+ נוסעים" action, as the Sadran. */
async function cmdAddPassengers(board: Board, args: Args): Promise<void> {
  const ride = resolveRide(board, need(args.pos[0], "<rideId>"));
  if (!ride.id) throw new UsageError("ride has no id");
  const names = args.pos.slice(1);
  if (!names.length) throw new UsageError("add-passengers <ride> <name>[:adult|child_seat|booster]...");
  const passengers = names.map((token) => {
    const [name, kind] = token.split(":");
    const seat = (kind ?? "adult") as "adult" | "child_seat" | "booster";
    if (!["adult", "child_seat", "booster"].includes(seat)) throw new UsageError(`seat kind must be adult|child_seat|booster (got ${kind})`);
    return { display_name: name!, seat_kind: seat };
  });
  await addRidePassengers(ride.id, ride.version ?? 0, passengers);
  console.log(`added ${passengers.map((p) => `${p.display_name}(${p.seat_kind})`).join(", ")} to ride ${short(ride.id)}`);
}

interface MemberContact { id: string; name: string; phone: string | null; role: string; email: string | null }
async function loadMembers(board: Board): Promise<MemberContact[]> {
  const { data, error } = await supabase.from("department_members").select("profile_id, role").eq("department_id", board.scope.departmentId).is("removed_at", null);
  if (error) throw new Error(error.message);
  const ids = (data ?? []).map((m) => m.profile_id);
  const profiles = await fetchProfilesByIds(ids);
  const { data: emailRows } = await supabase.from("profiles").select("id, email").in("id", ids);
  const emails = new Map((emailRows ?? []).map((r) => [r.id, r.email as string | null]));
  return profiles.map((p) => ({ id: p.id, name: p.full_name, phone: p.phone, email: emails.get(p.id) ?? null, role: (data ?? []).find((m) => m.profile_id === p.id)?.role ?? "member" }));
}
function pickMember(members: readonly MemberContact[], token: string): MemberContact {
  const lower = token.toLowerCase();
  const found = members.filter((m) => m.id === token || m.id.endsWith(token) || m.id.startsWith(token) || m.name.toLowerCase().includes(lower));
  if (found.length !== 1) throw new UsageError(`member '${token}' ${found.length ? `is ambiguous (${found.slice(0, 5).map((m) => m.name).join(", ")})` : "not found"}`);
  return found[0]!;
}

/** `contacts [<name filter>]` - the Sadran's contact list (name, phone, id) for WhatsApp follow-ups. */
async function cmdContacts(board: Board, args: Args): Promise<void> {
  const filter = args.pos[0]?.toLowerCase();
  const members = (await loadMembers(board)).filter((m) => !filter || m.name.toLowerCase().includes(filter) || (m.email ?? "").toLowerCase().includes(filter)).sort((a, b) => a.name.localeCompare(b.name));
  for (const m of members) console.log(`${m.name} | ${m.email ?? "no email"} | ${m.phone ?? "no phone"} | ${m.role} | ${short(m.id)}`);
  console.log(`(${members.length} members)`);
}

/** `fewer-days <request> <first-day> <last-day> [--car C] [--draft]` - the board's "להציע פחות ימים": a shift proposal with `series_span`. */
async function cmdFewerDays(board: Board, args: Args): Promise<void> {
  const request = resolveRequest(board, need(args.pos[0], "<requestId>"));
  const firstDay = need(args.pos[1], "<first-day yyyy-mm-dd>");
  const lastDay = need(args.pos[2], "<last-day yyyy-mm-dd>");
  if (!request.series_id) throw new UsageError("that request is not part of a multi-day series");
  const legs = activeSeriesLegs(await api.fetchSeriesLegs(request.series_id));
  const from = legs.findIndex((l) => dayOf(l.departAt) === firstDay);
  const to = legs.findIndex((l) => dayOf(l.departAt) === lastDay);
  if (from < 0 || to < 0) throw new UsageError(`days must be legs of the series (${legs.map((l) => dayOf(l.departAt)).join(", ")})`);
  if (to < from) throw new UsageError("the last day cannot be before the first day (a single day is allowed, REQ §13.105 d)");
  const span = buildSeriesSpan(legs, from, to);
  if (!span) throw new UsageError("the span must be consecutive, non-empty and strictly shorter than the whole series");
  const hidden = draftHiddenRideIds(board);
  const busy = (carId: string) => board.rides.some((r) => r.car_id === carId && r.status !== "cancelled" && !(r.id && hidden.has(r.id)) && r.starts_at && r.ends_at
    && Date.parse(span.depart_at) < Date.parse(r.ends_at) && Date.parse(r.starts_at) < Date.parse(span.return_at));
  const car = flag(args, "car") ? resolveCar(board, flag(args, "car")!)
    : board.cars.find((c) => c.status === "active" && c.type === "shared" && !busy(c.id) && !board.maintenance.some((m) => m.car_id === c.id && Date.parse(span.depart_at) < Date.parse(m.ends_at) && Date.parse(m.starts_at) < Date.parse(span.return_at)));
  if (!car) throw new UsageError("no car is free for the whole span (give --car)");
  const head = seriesHead(legs);
  const requestId = head && board.requests.some((r) => r.id === head.id) ? head.id : request.id;
  console.log(`fewer days ${firstDay}..${lastDay} on ${car.name}${requestId !== request.id ? ` (proposal on the series head ${short(requestId)})` : ""}`);
  await createProposalFrom(board, seriesSpanPrefill(requestId, car.id, span), has(args, "draft"));
}

/** `withdraw-duplicate <request>` - the board's "withdraw as duplicate" (the member is notified and may answer "not a duplicate"). */
async function cmdWithdrawDuplicate(board: Board, args: Args): Promise<void> {
  const request = resolveRequest(board, need(args.pos[0], "<requestId>"));
  await api.withdrawDuplicateRequest(request.id, request.version);
  console.log(`request ${short(request.id)} (${request.requester_full_name ?? "?"}) withdrawn as a duplicate`);
}

async function cmdAdvanceLive(board: Board): Promise<void> {
  // The cron job (`app.tick()` -> `advance_week_phases`) is not reachable from a browser session, and calling it
  // with a future "now" would also close/archive other departments' and earlier weeks. On the disposable stack the
  // service role flips just this department/week from published to live (what the tick does once the week starts).
  const service = createClient(process.env.VITE_SUPABASE_URL as string, process.env.QA_SERVICE_KEY as string, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: before } = await service.from("weeks").select("phase").eq("department_id", board.scope.departmentId).eq("week_start", board.scope.weekStart).single();
  if (before?.phase !== "published") throw new UsageError(`week is ${before?.phase}; only a published week can go live (publish first)`);
  const { error } = await service.from("weeks").update({ phase: "live" }).eq("department_id", board.scope.departmentId).eq("week_start", board.scope.weekStart).eq("phase", "published");
  if (error) throw new Error(`could not advance the week: ${error.message}`);
  console.log(`week ${board.scope.weekStart} phase: published -> live`);
}

function usage(): void {
  console.log(`qa:sadran <command> [--out DIR] [--email E --password P] [--dept NAME|ID] [--week YYYY-MM-DD]
  week | day <date> | requests [<date>] [--status S] | proposals
  autofill [--day D] [--dry-run] | resolve-full [--dry-run]
  place <req> <car> <HH:MM> [--leg out|return] [--force]
  move <ride> [--car C] [--start HH:MM] [--end HH:MM] [--propose [--draft]]
  merge <req> <ride> [--leg out|return|both] [--draft] | unmerge <ride> <req>
  trip-type <req> <round_trip|one_way|drop_off>
  edit-route <ride|req> [--origin P] [--dest P] [--stop P]... [--return-stop P]... [--clear-stops] [--draft]
  propose <req> shift [--car C --depart HH:MM --return HH:MM --day D --ride R --no-places] | origin --origin P --car C | deny [--reason T] | external [--hint cab|rental|public_transport|private|waive] [--reason T] | alternative --car C --depart HH:MM [--return HH:MM] [--return-car C]  [--draft]
  send <proposal> | withdraw <proposal> | discard <proposal> | apply <proposal>
  unassign <ride> | cancel-ride <ride> [reason] | reserve <car> <day> <HH:MM-HH:MM> <note> | car-move <car> <from> <to> <HH:MM> [--day D] [--minutes N]
  message <memberEmail> <text> | messages [--new]
  fewer-days <req> <first-day> <last-day> [--car C] [--draft] | withdraw-duplicate <req>
  assign-driver <ride> <member|none> | add-passengers <ride> <name>[:adult|child_seat|booster]... | contacts [<name>]
  publish [--days d1,d2] [--allow-unanswered] | advance live`);
}

run(async () => {
  const args = parseArgs(process.argv.slice(process.argv.indexOf("--") + 1 || 2));
  if (args.cmd === "help") { usage(); return; }
  const { board } = await open(args);
  switch (args.cmd) {
    case "week": return cmdWeek(board);
    case "day": return cmdDay(board, need(args.pos[0], "<yyyy-mm-dd>"));
    case "requests": return cmdRequests(board, args);
    case "proposals": return cmdProposals(board);
    case "autofill": return applyOutput(board, "remaining", args);
    case "resolve-full": return applyOutput(board, "full", args);
    case "place": return cmdPlace(board, args);
    case "move": return cmdMove(board, args);
    case "merge": return cmdMerge(board, args);
    case "unmerge": return cmdUnmerge(board, args);
    case "trip-type": return cmdTripType(board, args);
    case "edit-route": return cmdEditRoute(board, args);
    case "propose": return cmdPropose(board, args);
    case "send": return cmdSend(board, args);
    case "withdraw": { await api.withdrawProposal(resolveId(need(args.pos[0], "<proposalId>"), board.proposals.map((p) => p.id), "proposal")); console.log("withdrawn"); return; }
    case "discard": { await api.discardProposal(resolveId(need(args.pos[0], "<proposalId>"), board.proposals.map((p) => p.id), "proposal")); console.log("discarded"); return; }
    case "apply": return cmdApply(args, board);
    case "unassign": { const r = resolveRide(board, need(args.pos[0], "<rideId>")); await api.unassignRide(r.id as string, r.version ?? 0); console.log(`ride ${short(r.id)} unassigned; its requests are unmet again`); return; }
    case "cancel-ride": { const r = resolveRide(board, need(args.pos[0], "<rideId>")); await api.cancelRide(r.id as string, args.pos.slice(1).join(" ") || "qa", r.version ?? undefined); console.log(`ride ${short(r.id)} cancelled`); return; }
    case "reserve": return cmdReserve(board, args);
    case "car-move": return cmdCarMove(board, args);
    case "assign-driver": return cmdAssignDriver(board, args);
    case "add-passengers": return cmdAddPassengers(board, args);
    case "contacts": return cmdContacts(board, args);
    case "fewer-days": return cmdFewerDays(board, args);
    case "withdraw-duplicate": return cmdWithdrawDuplicate(board, args);
    case "message": {
      const to = need(args.pos[0], "<memberEmail>"); const text = args.pos.slice(1).join(" ");
      if (!text) throw new UsageError("message <memberEmail> <text>");
      appendMail(OUT, { from: SADRAN_EMAIL, to, text, re: flag(args, "re") });
      console.log(`message to ${to} written to the mailbox`); return;
    }
    case "messages": printMail(mailFor(OUT, SADRAN_EMAIL, has(args, "new"), ["sadran"])); return;
    case "publish": return cmdPublish(board, args);
    case "advance": if (args.pos[0] === "live") return cmdAdvanceLive(board); throw new UsageError("advance live");
    default: usage(); throw new UsageError(`unknown command ${args.cmd}`);
  }
});
