// `npm run qa:member -- --as <email> <command>` — what a member does in the app, through the app's
// own api functions / RPCs, signed in as that member on the disposable stack.
import { fromZonedTime } from "date-fns-tz";

import { fetchDestinations, fetchRideTypes } from "@/features/fleet/api";
import { fetchNotifications, fetchProposalLink, markAllNotificationsRead } from "@/features/inbox/api";
import { answerProposal } from "@/features/proposals/api";
import { carNowWindow } from "@/features/requests/carNow";
import { destinationValuesToStopPayload } from "@/features/requests/stops";
import * as requests from "@/features/requests/api";
import { fetchBoardRides, fetchMyUpcomingRides } from "@/features/siddur/api";
import { servedOf, rideViaNames } from "@/features/sadran/applySolve";
import { fetchWaitlistGroups, resolveWaitlistGroup } from "@/features/waitlist/api";
import { orderedSelection } from "@/features/waitlist/orderedSelection";
import { supabase } from "@/integrations/supabase/client";
import { parseRideRoute } from "@/lib/rideRoute";
import { TZ, dateKey, formatTime, weekStartFor } from "@/lib/time";
import { parseHHMM, formatMinutes } from "@/components/timeField15Format";

import {
  UsageError, appendMail, flag, flagAll, has, mailFor, memberPassword, need, outDir, parseArgs, printMail, resolveId, resolvePlaceToken, resolveScope, run, scopeHint, short, signIn,
  type Args, type Scope,
} from "./lib/common";

const t = (iso: string | null | undefined): string => (iso ? formatTime(new Date(iso)) : "--:--");
const instantAt = (day: string, hhmm: string): string => {
  const m = parseHHMM(hhmm);
  if (m == null) throw new UsageError(`bad time ${hhmm} (want HH:MM)`);
  return fromZonedTime(`${day}T${formatMinutes(m)}:00`, TZ).toISOString();
};
const oneLine = (text: string): string => text.replace(/\{\{\s*link\s*\}\}/g, "(link: use `answer <proposalId> accept|decline`)").replace(/\s+/g, " ").trim();
const FLEX: Record<string, string> = { "0": "0", "15": "15 min", "30": "30 min", "60": "1 hour", "120": "2 hours", any: "1 day", day: "1 day" };
const flex = (value: string | undefined): string | undefined => (value === undefined ? undefined : FLEX[value] ?? (() => { throw new UsageError(`flex must be one of ${Object.keys(FLEX).join(",")}`); })());
const weekOf = (day: string): string => dateKey(weekStartFor(new Date(instantAt(day, "12:00"))));

type TripKind = "round_trip" | "one_way" | "drop_off";
function shapeFor(type: TripKind, args: Args): "round_trip" | "one_way_to" | "one_way_from" {
  if (type === "round_trip") return "round_trip";
  if (has(args, "from")) return "one_way_from";
  if (type === "drop_off" && has(args, "pickup")) return "round_trip";
  return "one_way_to";
}

let OUT = "";
let EMAIL = "";
let ME = "";
let SCOPE: Scope | null = null;

async function open(args: Args): Promise<void> {
  OUT = outDir(args);
  EMAIL = need(flag(args, "as"), "--as <memberEmail>");
  const user = await signIn({ email: EMAIL, password: flag(args, "password") ?? memberPassword(OUT, EMAIL) });
  ME = user.id;
  const hint = scopeHint(OUT);
  const day = args.cmd === "request" || args.cmd === "siddur" ? args.pos[0] ?? flag(args, "day") : flag(args, "day");
  SCOPE = await resolveScope(args, { departmentId: hint.departmentId, weekStart: day && /^\d{4}-\d\d-\d\d$/.test(day) ? weekOf(day) : hint.weekStart }).catch(() => null);
}

function reqLine(r: requests.MyRequestRow): string {
  const route = `${r.originName ?? r.originText ?? "home"}->${r.destination}${r.stops.length ? ` via ${r.stops.map((s) => s.name).join(",")}` : ""}`;
  const ride = r.ride ? ` ride=${short(r.ride.id)} ${t(r.ride.startsAt)}-${t(r.ride.endsAt)}` : "";
  const prop = r.pendingProposal ? ` PROPOSAL=${short(r.pendingProposal.id)}/${r.pendingProposal.type} "${oneLine(r.pendingProposal.reasonHe)}"` : "";
  return `req ${short(r.id)} ${dateKey(r.departAt ?? r.returnAt ?? r.weekStart)} ${r.tripType} ${route} dep ${t(r.departAt)}${r.returnAt ? ` ret ${t(r.returnAt)}` : ""} status=${r.status}${r.statusReason ? `(${r.statusReason})` : ""}${r.isLate ? " LATE" : ""}${r.changedSinceSolve ? " changed" : ""}${ride}${prop}`;
}

async function cmdInbox(args: Args): Promise<void> {
  const rows = await fetchNotifications(ME);
  const shown = has(args, "all") ? rows : rows.slice(0, Number(flag(args, "limit") ?? 15));
  for (const n of shown) console.log(`[${n.created_at.slice(0, 16)}] ${n.read_at ? " " : "*"} ${n.event} ${short(n.id)} ${oneLine(n.title_he)} | ${oneLine(n.body_he)} | ${(n.data as { url?: string } | null)?.url ?? ""}`);
  console.log(`(${rows.length} notifications, ${rows.filter((n) => !n.read_at).length} unread)`);
  printMail(mailFor(OUT, EMAIL, true));
  if (has(args, "mark-read")) await markAllNotificationsRead(ME);
}

async function proposalType(id: string): Promise<string> {
  const { data } = await supabase.from("proposals").select("type").eq("id", id).maybeSingle();
  return data?.type ?? "?";
}

async function cmdProposals(): Promise<void> {
  const mine = await requests.fetchMyRequests(ME, SCOPE?.departmentId);
  const pending = mine.filter((r) => r.pendingProposal);
  for (const r of pending) console.log(`proposal ${short(r.pendingProposal!.id)} ${r.pendingProposal!.type} on ${reqLine(r)}`);
  // Merge proposals also address other parties (host/driver); their copy lives in the inbox.
  const notes = (await fetchNotifications(ME)).filter((n) => n.event === "proposal_received" && !n.read_at);
  for (const n of notes) {
    const id = (n.data as { proposal_id?: string } | null)?.proposal_id;
    if (id && !pending.some((r) => r.pendingProposal!.id === id)) console.log(`proposal ${short(id)}/${await proposalType(id)} (inbox, unread) ${oneLine(n.title_he)} | ${oneLine(n.body_he)}`);
  }
  if (!pending.length && !notes.length) console.log("(no pending proposals)");
}

async function tokenFor(idOrToken: string): Promise<{ token: string; proposalId?: string }> {
  if (!/^[0-9a-f-]{8,36}$/i.test(idOrToken) || idOrToken.length < 8) return { token: idOrToken };
  const notes = (await fetchNotifications(ME)).filter((n) => n.event === "proposal_received");
  const ids = notes.flatMap((n) => { const id = (n.data as { proposal_id?: string } | null)?.proposal_id; return id ? [id] : []; });
  const proposalId = resolveId(idOrToken, [...new Set(ids)], "proposal (in your inbox)");
  const url = await fetchProposalLink(proposalId);
  const token = url?.split("/p/")[1]?.split(/[?#]/)[0];
  if (!token) throw new UsageError(`no /p/<token> link found for proposal ${short(proposalId)}`);
  return { token, proposalId };
}

async function cmdAnswer(args: Args): Promise<void> {
  const given = need(args.pos[0], "<proposalId|token>");
  const { token, proposalId } = await tokenFor(given);
  const type = proposalId ? await proposalType(proposalId) : "?";
  const answer = need(args.pos[1], "accept|decline");
  if (answer !== "accept" && answer !== "decline") throw new UsageError("answer must be accept or decline");
  await answerProposal({ token, accept: answer === "accept", note: flag(args, "note"), via: "session" });
  console.log(`answered ${answer} (${type} proposal)`);
}

async function cmdMyRides(): Promise<void> {
  const rides = await fetchMyUpcomingRides(ME, SCOPE?.departmentId);
  const mine = await requests.fetchMyRequests(ME, SCOPE?.departmentId);
  console.log(`MY RIDES (${rides.length})`);
  for (const r of rides) {
    // My own route (my request's places), not the car's home->home; the car's legs are shown after "car".
    const own = mine.find((q) => q.ride?.id === r.id);
    const myRoute = own ? `${own.originName ?? own.originText ?? "home"}->${own.destination}${own.stops.length ? ` via ${own.stops.map((x) => x.name).join(",")}` : ""}` : null;
    console.log(`  ride ${short(r.id)} ${dateKey(r.starts_at as string)} ${t(r.starts_at)}-${t(r.ends_at)} ${myRoute ? `my route ${myRoute} (car ${r.origin_name}->${r.destination_name})` : `${r.origin_name}->${r.destination_name}`} car=${r.car_name ?? "?"} driver=${r.needs_driver ? "(none yet)" : r.driver_name ?? "-"}${r.driver_id === ME ? " (I drive)" : ""} status=${r.status} | ${servedOf(r).map((e) => e.requester).join(", ")}`);
  }
  console.log(`MY REQUESTS (${mine.length})`);
  for (const r of mine) console.log(`  ${reqLine(r)}`);
}

/** The ride's route as the people on it travel: `v_board_rides.route` points, else the served requests' places (never the car's home->home). */
function routeText(r: Awaited<ReturnType<typeof fetchBoardRides>>[number]): string {
  const points = parseRideRoute(r.route);
  const chain = (leg: "out" | "return") => points.filter((p) => p.leg === leg).sort((a, b) => a.position - b.position).map((p) => p.name).filter(Boolean);
  const out = chain("out");
  const back = chain("return");
  if (out.length >= 2) return `route ${out.join(" > ")}${back.length >= 2 && back.join(">") !== [...out].reverse().join(">") ? ` | return ${back.join(" > ")}` : ""}`;
  const served = servedOf(r).filter((e) => e.destination);
  if (served.length) return `route ${[...new Set(served.map((e) => `${e.origin_name ?? e.origin_text ?? r.origin_name ?? "home"}>${e.destination}`))].join(" ; ")}`;
  const via = rideViaNames(r);
  return `${r.origin_name}->${r.destination_name}${via.out.length ? ` via ${via.out.join(",")}` : ""}`;
}

async function cmdSiddur(args: Args): Promise<void> {
  const day = need(args.pos[0], "<yyyy-mm-dd>");
  if (!SCOPE) throw new UsageError("department not found");
  const week = weekOf(day);
  const rides = (await fetchBoardRides(SCOPE.departmentId, week)).filter((r) => r.starts_at && dateKey(r.starts_at) === day && r.status !== "cancelled");
  const { data: carRows } = await supabase.from("cars").select("id, name");
  const carNames = new Map((carRows ?? []).map((c) => [c.id, c.name]));
  console.log(`SIDDUR ${day} (week ${week}) as ${EMAIL}: ${rides.length} rides visible`);
  for (const r of rides) {
    const mineFlag = r.driver_id === ME ? " [I DRIVE]" : "";
    console.log(`  ride ${short(r.id)} ${t(r.starts_at)}-${t(r.ends_at)} ${routeText(r)} car=${carNames.get(r.car_id ?? "") ?? short(r.car_id)} driver=${r.needs_driver ? "(none yet)" : r.driver_name ?? "-"} status=${r.status}${mineFlag} | ${servedOf(r).map((e) => `${e.requester}(${e.leg})`).join(", ")}${r.notes ? ` | ${r.notes}` : ""}`);
  }
}

function placeOf(destinations: { id: string; name: string }[], token: string | undefined) {
  return token === undefined ? undefined : resolvePlaceToken(destinations, token);
}

async function cmdEdit(args: Args): Promise<void> {
  const id = resolveId(need(args.pos[0], "<requestId>"), (await requests.fetchMyRequests(ME)).map((r) => r.id), "request");
  const row = await requests.fetchRequestById(id, ME);
  if (!row) throw new UsageError("request not found");
  const destinations = await fetchDestinations(row.departmentId);
  const day = flag(args, "day") ?? dateKey(row.departAt ?? row.returnAt ?? row.weekStart);
  const dest = placeOf(destinations, flag(args, "dest"));
  const origin = placeOf(destinations, flag(args, "origin"));
  const tripType = (flag(args, "trip-type") as TripKind | undefined) ?? row.tripType;
  const shape = flag(args, "trip-type") ? shapeFor(tripType, args) : row.tripShape;
  const departAt = flag(args, "depart") ? instantAt(day, flag(args, "depart")!) : row.departAt ?? undefined;
  const returnRaw = flag(args, "return") ? instantAt(flag(args, "return-day") ?? day, flag(args, "return")!) : row.returnAt ?? row.keptReturnAt ?? undefined;
  const outStops = has(args, "clear-stops") ? [] : flagAll(args, "stop").length ? flagAll(args, "stop").map((s) => resolvePlaceToken(destinations, s)) : row.outStops;
  const returnStops = has(args, "clear-stops") ? [] : flagAll(args, "return-stop").length ? flagAll(args, "return-stop").map((s) => resolvePlaceToken(destinations, s)) : row.returnStops;
  const f = flex(flag(args, "flex"));
  const payload: requests.SubmitRequestPayload = {
    department_id: row.departmentId, week_start: row.weekStart,
    destination_id: dest ? ("presetId" in dest ? dest.presetId : undefined) : row.destinationId ?? undefined,
    destination_text: dest ? ("freeText" in dest ? dest.freeText : undefined) : row.destinationText ?? undefined,
    origin_id: origin ? ("presetId" in origin ? origin.presetId : undefined) : row.originId ?? undefined,
    origin_text: origin ? ("freeText" in origin ? origin.freeText : undefined) : row.originText ?? undefined,
    trip_type: tripType, ride_type_id: row.rideTypeId, preferred_car_id: flag(args, "car") ? flag(args, "car") : row.preferredCarId ?? null,
    trip_shape: shape,
    depart_at: shape === "one_way_from" ? undefined : departAt,
    return_at: shape === "one_way_to" ? undefined : returnRaw,
    adults: Number(flag(args, "adults") ?? row.adults), child_seats: Number(flag(args, "child-seats") ?? row.childSeats), boosters: Number(flag(args, "boosters") ?? row.boosters),
    has_luggage: row.hasLuggage,
    flex_depart_early: flex(flag(args, "flex-depart-early")) ?? f ?? row.flexDepartEarly, flex_depart_late: flex(flag(args, "flex-depart-late")) ?? f ?? row.flexDepartLate,
    flex_return_early: flex(flag(args, "flex-return-early")) ?? f ?? row.flexReturnEarly, flex_return_late: flex(flag(args, "flex-return-late")) ?? f ?? row.flexReturnLate,
    notes: flag(args, "notes") ?? row.notes ?? undefined, ride_description: row.rideDescription,
    guest_passenger_names: row.guestPassengerNames.length ? row.guestPassengerNames : undefined,
    request_id: row.id, expected_version: row.version,
    stops: [...destinationValuesToStopPayload(outStops, "out"), ...destinationValuesToStopPayload(returnStops, "return")],
  };
  if (payload.preferred_car_id && flag(args, "car")) throw new UsageError("--car takes a car id here (members do not see the board); omit it to keep the preference");
  const result = await requests.submitRequest(payload) as unknown as requests.SubmitRequestResult;
  console.log(`edited ${short(id)}: late=${result.is_late} warnings=${(result.warnings ?? []).join(",") || "-"}${result.status ? ` status=${result.status}` : ""}${result.ride_id ? ` ride=${short(result.ride_id)}` : ""}${result.reason ? ` reason=${result.reason}` : ""}`);
}

async function cmdRequest(args: Args, forceToday = false): Promise<void> {
  if (!SCOPE) throw new UsageError("department not found");
  const destinations = await fetchDestinations(SCOPE.departmentId);
  const rideTypes = await fetchRideTypes(SCOPE.departmentId);
  const hours = Number(flag(args, "hours") ?? 2);
  const nowWindow = forceToday ? carNowWindow(new Date(), hours) : null;
  const day = nowWindow?.day ?? need(args.pos[0] ?? flag(args, "day"), "<yyyy-mm-dd> (the departure day)");
  const type = (flag(args, "trip") ?? flag(args, "trip-type") ?? "round_trip") as TripKind;
  if (!["round_trip", "one_way", "drop_off"].includes(type)) throw new UsageError("--trip round_trip|one_way|drop_off");
  const shape = shapeFor(type, args);
  const depart = nowWindow?.departTime ?? flag(args, "depart");
  const ret = nowWindow?.returnTime ?? flag(args, "return");
  if (shape !== "one_way_from") need(depart, "--depart HH:MM");
  if (shape !== "one_way_to") need(ret, "--return HH:MM");
  const dest = resolvePlaceToken(destinations, need(flag(args, "dest"), "--dest <place|free:text>"));
  const origin = placeOf(destinations, flag(args, "origin"));
  const rideTypeToken = flag(args, "ride-type");
  const rideType = rideTypeToken ? rideTypes.find((r) => r.code === rideTypeToken || r.name_he === rideTypeToken || r.id === rideTypeToken) : rideTypes.find((r) => r.code === "other") ?? rideTypes[0];
  if (!rideType) throw new UsageError(`ride type not found (have: ${rideTypes.map((r) => r.code).join(", ")})`);
  const returnDay = flag(args, "return-day");
  const f = flex(flag(args, "flex"));
  const payload: requests.SubmitRequestPayload = {
    department_id: SCOPE.departmentId, week_start: weekOf(day),
    destination_id: "presetId" in dest ? dest.presetId : undefined, destination_text: "freeText" in dest ? dest.freeText : undefined,
    origin_id: origin && "presetId" in origin ? origin.presetId : undefined, origin_text: origin && "freeText" in origin ? origin.freeText : undefined,
    trip_type: type, ride_type_id: rideType.id, trip_shape: shape,
    depart_at: shape === "one_way_from" ? undefined : instantAt(day, depart!), return_at: shape === "one_way_to" ? undefined : instantAt(returnDay ?? day, ret!),
    adults: Number(flag(args, "adults") ?? 1), child_seats: Number(flag(args, "child-seats") ?? 0), boosters: Number(flag(args, "boosters") ?? 0),
    has_luggage: has(args, "luggage"),
    flex_depart_early: flex(flag(args, "flex-depart-early")) ?? f ?? "0", flex_depart_late: flex(flag(args, "flex-depart-late")) ?? f ?? "0",
    flex_return_early: flex(flag(args, "flex-return-early")) ?? f ?? "0", flex_return_late: flex(flag(args, "flex-return-late")) ?? f ?? "0",
    notes: flag(args, "notes"), preferred_car_id: flag(args, "car") ?? null, waitlist: has(args, "waitlist") || undefined,
    stops: [...destinationValuesToStopPayload(flagAll(args, "stop").map((s) => resolvePlaceToken(destinations, s)), "out"),
      ...destinationValuesToStopPayload(flagAll(args, "return-stop").map((s) => resolvePlaceToken(destinations, s)), "return")],
  };
  const result = (returnDay && returnDay > day ? await requests.submitSeriesRequest(payload) : await requests.submitRequest(payload)) as unknown as requests.SubmitRequestResult & { series_id?: string; request_ids?: string[] };
  console.log(`filed: ${result.request_ids ? `series ${short(result.series_id)} requests ${result.request_ids.map(short).join(",")}` : `request ${short(result.request_id)}`} late=${result.is_late ?? "-"} status=${result.status ?? "submitted"}${result.ride_id ? ` ride=${short(result.ride_id)}` : ""}${result.car_id ? ` car=${short(result.car_id)}` : ""}${result.reason ? ` reason=${result.reason}` : ""}${result.warnings?.length ? ` warnings=${result.warnings.join(",")}` : ""}`);
}

/** `ask-to-join <ride> [--adults N] [--notes T]` - files a normal request that joins that ride (`join_ride_id`). */
async function cmdAskToJoin(args: Args): Promise<void> {
  if (!SCOPE) throw new UsageError("department not found");
  const day = need(flag(args, "day"), "--day <yyyy-mm-dd> (the ride's day)");
  const rides = (await fetchBoardRides(SCOPE.departmentId, weekOf(day))).filter((r) => r.status !== "cancelled");
  const ride = rides.find((r) => r.id === resolveId(need(args.pos[0], "<rideId>"), rides.flatMap((x) => (x.id ? [x.id] : [])), "ride"))!;
  if (!ride.starts_at || !ride.ends_at) throw new UsageError("ride lacks times");
  // The real destination is the served request's (the ride's own end place is where the car stops, often home).
  const destinations = await fetchDestinations(SCOPE.departmentId);
  const entry = servedOf(ride).find((e) => e.role === "driver" && e.destination) ?? servedOf(ride).find((e) => e.destination);
  const place = flag(args, "dest") ? resolvePlaceToken(destinations, flag(args, "dest")!)
    : entry?.destination ? (destinations.find((d) => d.name === entry.destination) ? { presetId: destinations.find((d) => d.name === entry.destination)!.id } : { freeText: entry.destination })
    : ride.destination_id ? { presetId: ride.destination_id } : null;
  if (!place) throw new UsageError("cannot tell the ride's destination (give --dest <place>)");
  const rideTypes = await fetchRideTypes(SCOPE.departmentId);
  const rideType = rideTypes.find((r) => r.code === "other") ?? rideTypes[0];
  if (!rideType) throw new UsageError("no ride type available");
  const result = await requests.submitRequest({
    department_id: SCOPE.departmentId, week_start: ride.week_start ?? weekOf(day), destination_id: "presetId" in place ? place.presetId : undefined, destination_text: "freeText" in place ? place.freeText : undefined, ride_type_id: rideType.id, trip_shape: "round_trip", trip_type: "round_trip",
    depart_at: ride.starts_at, return_at: ride.ends_at, adults: Number(flag(args, "adults") ?? 1), child_seats: 0, boosters: 0,
    flex_depart_early: "0", flex_depart_late: "0", flex_return_early: "0", flex_return_late: "0", notes: flag(args, "notes"), join_ride_id: ride.id as string,
  }) as unknown as requests.SubmitRequestResult;
  console.log(`asked to join ride ${short(ride.id)}: request ${short(result.request_id)} status=${result.status ?? "submitted"}${result.reason ? ` reason=${result.reason}` : ""}`);
}

/** `groups [--day D]` - the open contested waiting-list groups of the week ("בדיון"). */
async function cmdGroups(): Promise<void> {
  if (!SCOPE) throw new UsageError("department not found");
  const groups = await fetchWaitlistGroups(SCOPE.departmentId, SCOPE.weekStart);
  for (const g of groups) console.log(`group ${short(g.id)} ${dateKey(g.starts_at)} ${t(g.starts_at)}-${t(g.ends_at)} v${g.version}: ${g.members.map((m) => `${m.name}[req ${short(m.request_id)} ${m.adults}a ${m.destination}${m.profile_id === ME ? " (me)" : ""}]`).join(", ")}`);
  console.log(`(${groups.length} open groups in week ${SCOPE.weekStart})`);
}

/** `resolve-group <group> <member,...> [--driver X]` - a participant settles a contested group by ticking who rides (first = driver). */
async function cmdResolveGroup(args: Args): Promise<void> {
  if (!SCOPE) throw new UsageError("department not found");
  const groups = await fetchWaitlistGroups(SCOPE.departmentId, SCOPE.weekStart);
  const group = groups.find((g) => g.id === resolveId(need(args.pos[0], "<groupId>"), groups.map((g) => g.id), "group (open, this week; use --day for another week)"))!;
  const pick = (token: string): string => {
    const lower = token.toLowerCase();
    const found = group.members.filter((m) => m.request_id.endsWith(token) || m.profile_id.endsWith(token) || m.name.toLowerCase().includes(lower));
    if (found.length !== 1) throw new UsageError(`member '${token}' ${found.length ? "is ambiguous" : "is not in the group"} (members: ${group.members.map((m) => m.name).join(", ")})`);
    return found[0]!.request_id;
  };
  const ticked = need(args.pos[1], "<member,member,...> (first = driver)").split(",").map((x) => x.trim()).filter(Boolean).map(pick);
  const ids = orderedSelection(ticked, flag(args, "driver") ? pick(flag(args, "driver")!) : null);
  const res = await resolveWaitlistGroup(group.id, ids, group.version);
  console.log(`group ${short(group.id)} resolved: ride ${short(res.ride_id)} car ${short(res.car_id)} driver request ${short(res.driver_request_id)} chosen=${res.chosen.map(short).join(",")} not_chosen=${res.not_chosen.map(short).join(",") || "-"}`);
}

/** REQ §13.103 c: shorten my multi-day request to a consecutive sub-span (`shorten_series`). */
async function cmdShorten(args: Args): Promise<void> {
  const rows = await requests.fetchMyRequests(ME);
  const row = rows.find((r) => r.id === resolveId(need(args.pos[0], "<requestId>"), rows.map((r) => r.id), "request"))!;
  const firstDay = need(args.pos[1], "<first-day>");
  const lastDay = need(args.pos[3], "<last-day>");
  await requests.shortenSeries(row.id, instantAt(firstDay, need(args.pos[2], "<HH:MM>")), instantAt(lastDay, need(args.pos[4], "<HH:MM>")));
  console.log(`shortened ${short(row.id)} to ${firstDay} ${args.pos[2]} .. ${lastDay} ${args.pos[4]}`);
}

async function cmdWithdraw(args: Args): Promise<void> {
  const rows = await requests.fetchMyRequests(ME);
  const row = rows.find((r) => r.id === resolveId(need(args.pos[0], "<requestId>"), rows.map((r) => r.id), "request"))!;
  await requests.withdrawRequest(row.id, row.version);
  console.log(`withdrawn ${short(row.id)}`);
}

async function cmdCancel(args: Args): Promise<void> {
  const rows = await requests.fetchMyRequests(ME);
  const row = rows.find((r) => r.id === resolveId(need(args.pos[0], "<requestId>"), rows.map((r) => r.id), "request"))!;
  if (!row.ride) {
    // No ride to cancel: the request itself is what ends, i.e. `withdraw`.
    await requests.withdrawRequest(row.id, row.version);
    console.log(`request ${short(row.id)} has no ride; withdrawn it instead (same as \`withdraw\`)`);
    return;
  }
  const { data } = await supabase.from("rides").select("version").eq("id", row.ride.id).single();
  await requests.cancelRide(row.ride.id, args.pos.slice(1).join(" ") || "qa member cancel", data?.version ?? undefined);
  console.log(`cancelled ride ${short(row.ride.id)} of request ${short(row.id)}`);
}

function usage(): void {
  console.log(`qa:member --as <email> <command> [--out DIR] [--password P] [--dept NAME|ID]
  inbox [--all] [--mark-read] | proposals | answer <proposalId|token> accept|decline [--note T]
  messages [--new] | reply <text> [--re X] | my-rides | siddur <day>
  request <day> --depart HH:MM [--return HH:MM] --dest <place|free:text> [--trip round_trip|one_way|drop_off] [--from] [--pickup] [--origin P] [--stop P]... [--return-stop P]...
          [--adults N --child-seats N --boosters N --luggage] [--flex 0|15|30|60|120|any | --flex-depart-early/-late/--flex-return-early/-late] [--return-day D] [--car ID] [--ride-type CODE] [--notes T] [--waitlist]
  edit <req> [--day D --depart HH:MM --return HH:MM --dest P --origin P --trip-type T [--from|--pickup] --adults N --flex X --notes T --stop P... --clear-stops]
  groups | resolve-group <group> <member,...> [--driver X] (first listed drives)
  ask-to-join <ride> --day D [--dest P] [--adults N --notes T] | withdraw <req> | cancel <req> [reason] | shorten <req> <first-day> <HH:MM> <last-day> <HH:MM> | car-now --dest P [--hours N] [--adults N]`);
}

run(async () => {
  const args = parseArgs(process.argv.slice(process.argv.indexOf("--") + 1 || 2));
  if (args.cmd === "help") { usage(); return; }
  await open(args);
  switch (args.cmd) {
    case "inbox": return cmdInbox(args);
    case "proposals": return cmdProposals();
    case "answer": return cmdAnswer(args);
    case "messages": printMail(mailFor(OUT, EMAIL, has(args, "new"))); return;
    case "reply": {
      const text = args.pos.join(" ");
      if (!text) throw new UsageError("reply <text>");
      appendMail(OUT, { from: EMAIL, to: flag(args, "to") ?? "sadran", text, re: flag(args, "re") });
      console.log("reply written to the mailbox"); return;
    }
    case "my-rides": return cmdMyRides();
    case "siddur": return cmdSiddur(args);
    case "edit": return cmdEdit(args);
    case "ask-to-join": return cmdAskToJoin(args);
    case "groups": return cmdGroups();
    case "resolve-group": return cmdResolveGroup(args);
    case "withdraw": return cmdWithdraw(args);
    case "cancel": return cmdCancel(args);
    case "shorten": return cmdShorten(args);
    case "request": return cmdRequest(args);
    case "car-now": return cmdRequest(args, true);
    default: usage(); throw new UsageError(`unknown command ${args.cmd}`);
  }
});
