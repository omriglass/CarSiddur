#!/usr/bin/env node
// API-level suite (docs/TODO.md U1, U1a): drives the main flows as signed-in seeded users through PostgREST/RPC, so
// failures that only appear under role grants / RLS / mandatory-WHERE guards (the SQL suites run as the database
// owner) are caught. Runs in CI's database job (QA_API=1 in `npm run db:test`) and standalone:
//   QA_API_URL=<disposable api> node scripts/test-api.mjs
// Disposable local stacks only (scripts/qa/qa-common.mjs refuses :54321 unless CI opts in). Fixtures go in through
// the service role into random far-future weeks and are removed again; a week that was published keeps its immutable
// `siddur_versions` row (history is never rewritten), so that one empty week row is left behind by design.
//
// Cases (each acts as the right user, asserts success AND the resulting state):
//   cancel   passenger / chauffeur requester / driver cancel a ride, a stranger is refused (R5B1)
//   request  member submit_request -> edit with expected_version -> withdraw_request
//   proposal Sadran create_proposal (merge, shift) -> send_proposal -> members answer_proposal -> applied
//   publish  publish_siddur, then a plain member reads the rides (RLS); member cannot publish / propose / move a car
//   ride     add_ride_passengers + remove_ride_person, swap_day_cars by a member, mark_car_move, set_ride_driver
//   freed    cancelled ride on a published day -> freed-slot offer -> member claim_freed_slot -> Sadran approve_claim
//   series   multi-day request auto-placed on a published week -> member shorten_series
//   lifecycle (REQ 13.109) a drop-off cancelled with a merged guest releases both legs; ask-to-join own ride / origin = destination refused; volunteer driver replaced
//   planb    (REQ 13.112) member files a request with a plan B; RLS on request_alternatives; Sadran proposes it, publish waits (even with allow_unanswered), member accepts in-app -> served by plan B
//   asktojoin (REQ 13.116) ask-to-join on a private car is sent to its owner; the driver of a shared ride is told
//   triptype (R8B12) the Sadran switches an unplaced request to a drop-off; a free car takes it
//   maintenance (REQ 13.114) the responsible member creates / shortens a period, a plain member is refused; flagging; responsibility moves
//   live     (REQ 13.118) a member cancelling a chauffeur ride frees its car; the Sadran replaces a volunteer driver in one step; a placed multi-day series moves to another car on every day or not at all
//   neighbours a member reads v_ride_car_neighbours (next/previous ride on the car, tight gap) for a published ride
import { resolveApi, serviceClient, signedInClient, ADMIN_PASSWORD } from "./qa/qa-common.mjs";

const api = resolveApi();
const svc = serviceClient(api);
const DEPT = "00000000-0000-0000-0000-000000000001";
const HOME = "00000000-0000-0000-0000-000000000010";
const DEST = "00000000-0000-0000-0000-000000000011";
const TYPE = "00000000-0000-0000-0000-000000000021";
const CAR_A = "00000000-0000-0000-0000-000000000040";
const CAR_B = "00000000-0000-0000-0000-000000000041";
const PW = ADMIN_PASSWORD; // seeded demo password, e2e/helpers.ts SEEDED_USERS

const failures = [];
const knownBugs = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` - ${detail}`}`); if (!ok) failures.push(name); };
/** A check that fails because of a real application bug (reported, kept visible, but does not fail the run). */
const knownBug = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "BUG "} ${name}${ok ? "" : ` - ${detail}`}`); if (!ok) knownBugs.push(name); };
const must = (r, what) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };
const errText = (r) => r.error?.message ?? "no error";
/** Run one case; an exception inside it (setup failure, unexpected RPC error) fails that case, the others still run. */
async function section(title, fn) {
  console.log(`\n# ${title}`);
  try { await fn(); } catch (e) { check(`${title}: ${e.message}`, false, "unexpected exception"); }
}

const sadran = await signedInClient(api, "sadran@nevo.local", PW);
const m1 = await signedInClient(api, "member1@nevo.local", PW);
const m2 = await signedInClient(api, "member2@nevo.local", PW);
const id = async (c) => (await c.auth.getUser()).data.user.id;
const [sadranId, m1Id, m2Id] = [await id(sadran), await id(m1), await id(m2)];

// Far-future Sundays, random per run (a published week cannot be deleted, so runs must not collide).
const startMs = Date.now() + (1100 + Math.floor(Math.random() * 400) * 7) * 86400000;
const base = new Date(startMs);
base.setUTCDate(base.getUTCDate() - base.getUTCDay());
const weekStart = (n) => new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + 7 * n)).toISOString().slice(0, 10);
const dayDate = (n, day) => new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + 7 * n + day)).toISOString().slice(0, 10);
/** UTC instant `hour:minute` on `day` (0 = Sunday) of week n. 06:00-10:00 UTC stays inside one Jerusalem day. */
const at = (n, day, hour, minute = 0) => new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + 7 * n + day, hour, minute)).toISOString();

const madeWeeks = new Set();
async function mkWeek(n, phase, { open = false } = {}) {
  const row = open
    ? { open_at: new Date(Date.now() - 3600e3).toISOString(), close_at: new Date(Date.now() + 3 * 86400e3).toISOString(), publish_at: new Date(Date.now() + 4 * 86400e3).toISOString() }
    : { open_at: at(n, -20, 6), close_at: at(n, -19, 6), publish_at: at(n, -18, 6) };
  must(await svc.from("weeks").insert({ department_id: DEPT, week_start: weekStart(n), phase, ...row }), `insert week ${n}`);
  madeWeeks.add(weekStart(n));
  return weekStart(n);
}

/** A week the Sadran really published (all days) through publish_siddur, so the week row carries its siddur version. */
async function mkPublishedWeek(n) {
  const wk = await mkWeek(n, "solving");
  const fp = must(await sadran.rpc("publish_scores_fingerprint", { p_department_id: DEPT, p_week_start: wk }), "fingerprint");
  must(await sadran.rpc("publish_siddur", { p_department_id: DEPT, p_week_start: wk, p_profile_scores: [], p_expected_fingerprint: fp, p_policy_scores: [] }), `publish week ${n}`);
  return wk;
}

async function ride({ n, car, day, driver, needsDriver = false, status, origin = HOME, destination = HOME, hour = 6, endHour = 10 }) {
  return must(await svc.from("rides").insert({
    department_id: DEPT, week_start: weekStart(n), car_id: car, starts_at: at(n, day, hour), ends_at: at(n, day, endHour), origin_id: origin, destination_id: destination,
    driver_id: driver ?? null, needs_driver: needsDriver, status: status ?? (needsDriver ? "flagged" : "confirmed"), flag_reason: needsDriver ? "NEEDS_DRIVER" : null,
    is_pinned: true, pin_reason: needsDriver ? "MISSING_DRIVER" : "SADRAN_MANUAL", created_by: sadranId,
  }).select("id,version").single(), "insert ride");
}
async function request({ n, requester, day, status, hour = 6, endHour = 10 }) {
  return must(await svc.from("requests").insert({
    department_id: DEPT, week_start: weekStart(n), requester_id: requester, filed_by: sadranId, destination_id: DEST, ride_type_id: TYPE,
    depart_at: at(n, day, hour), return_at: at(n, day, endHour), trip_shape: "round_trip", status,
  }).select("id").single(), "insert request").id;
}
const link = async (rideId, requestId, role, carMode) =>
  must(await svc.from("ride_requests").insert({ ride_id: rideId, request_id: requestId, role, leg: "both", car_mode: carMode }), "link");
const rideRow = async (rideId) => must(await svc.from("rides").select("*").eq("id", rideId).single(), "ride row");
const version = async (rideId) => (await rideRow(rideId)).version;
const reqRow = async (requestId) => must(await svc.from("requests").select("*").eq("id", requestId).single(), "request row");

/** Removes everything the run created, children first. A published week keeps its `siddur_versions` row, so its week row stays. */
async function purge(weeks) {
  for (const w of weeks) {
    const scope = (q) => q.eq("department_id", DEPT).eq("week_start", w);
    const rides = (await scope(svc.from("rides").select("id"))).data ?? [];
    const rideIds = rides.map((r) => r.id);
    const steps = [
      ["notifications", scope(svc.from("notifications").delete())],
      ["freed_slot_offers", scope(svc.from("freed_slot_offers").delete())],
      ["proposals", scope(svc.from("proposals").delete())],
      ["ride_passengers", scope(svc.from("ride_passengers").delete())],
      ["ride_change_requests", scope(svc.from("ride_change_requests").delete())],
      ["waitlist_groups", scope(svc.from("waitlist_groups").delete())],
      ["rides", rideIds.length ? svc.from("rides").delete().in("id", rideIds) : null],
      ["requests", scope(svc.from("requests").delete())],
      ["week_stats", scope(svc.from("week_stats").delete())],
      ["solver_runs", scope(svc.from("solver_runs").delete())],
      ["sadran_assignments", svc.from("sadran_assignments").delete().eq("department_id", DEPT).eq("week_start", w)],
      ["weeks", svc.from("weeks").delete().eq("department_id", DEPT).eq("week_start", w)],
    ];
    for (const [table, q] of steps) {
      if (!q) continue;
      const { error } = await q;
      if (error && table !== "weeks") console.log(`cleanup: ${table} (${w}): ${error.message}`);
      if (error && table === "weeks") console.log(`cleanup: week ${w} stays (${error.message.includes("siddur_versions") ? "published: its history row is immutable" : error.message})`);
    }
  }
}

try {
  // ---------------------------------------------------------------------------------------------- cancel (R5B1)
  await section("cancel: passenger / chauffeur requester / driver / stranger", async () => {
    await mkPublishedWeek(0);   // R8B7: notices about a ride exist only for published days
    {
      const r = await ride({ n: 0, car: CAR_A, day: 1, driver: m1Id });
      const qd = await request({ n: 0, requester: m1Id, day: 1, status: "assigned" }); await link(r.id, qd, "driver", "keep");
      const qp = await request({ n: 0, requester: m2Id, day: 1, status: "merged" }); await link(r.id, qp, "passenger", "passenger");
      const res = await m2.rpc("cancel_ride", { p_ride_id: r.id, p_reason: "api test passenger", p_expected_version: await version(r.id) });
      check("member cancels a ride as passenger", !res.error, res.error?.message);
      const st = (await reqRow(qp)).status;
      check("  passenger request is cancelled", st === "cancelled", st);
      const driverNotified = must(await svc.from("notifications").select("id").eq("recipient_id", m1Id).eq("data->>variant", "passenger_left").eq("data->>ride_id", r.id), "notice").length;
      check("  driver is told the passenger left", driverNotified === 1, String(driverNotified));
    }
    {
      const r = await ride({ n: 0, car: CAR_B, day: 2, needsDriver: true });
      const q = await request({ n: 0, requester: m2Id, day: 2, status: "waitlisted" }); await link(r.id, q, "passenger", "chauffeur");
      const res = await m2.rpc("cancel_ride", { p_ride_id: r.id, p_reason: "api test chauffeur", p_expected_version: await version(r.id) });
      check("member cancels a chauffeur ride as requester", !res.error, res.error?.message);
      const st = (await rideRow(r.id)).status;
      check("  nobody left on it: ride is cancelled", st === "cancelled", st);
    }
    {
      const r = await ride({ n: 0, car: CAR_A, day: 3, driver: m1Id });
      const q = await request({ n: 0, requester: m1Id, day: 3, status: "assigned" }); await link(r.id, q, "driver", "keep");
      const res = await m1.rpc("cancel_ride", { p_ride_id: r.id, p_reason: "api test driver", p_expected_version: await version(r.id) });
      check("member cancels a ride as driver", !res.error, res.error?.message);
      const st = (await rideRow(r.id)).status;
      check("  ride is cancelled", st === "cancelled", st);
    }
    {
      const r = await ride({ n: 0, car: CAR_A, day: 4, driver: m1Id });
      const q = await request({ n: 0, requester: m1Id, day: 4, status: "assigned" }); await link(r.id, q, "driver", "keep");
      const res = await m2.rpc("cancel_ride", { p_ride_id: r.id, p_reason: "api test stranger", p_expected_version: await version(r.id) });
      check("a member with no part in the ride is refused", !!res.error && /not_authorized/.test(res.error.message), errText(res));
    }
  });

  // ------------------------------------------------------------------------- submit / edit / withdraw (open week)
  await section("request: submit_request -> edit with expected_version -> withdraw_request", async () => {
    const wk = await mkWeek(1, "open", { open: true });
    const payload = (extra = {}) => ({
      department_id: DEPT, week_start: wk, destination_id: DEST, ride_type_id: TYPE, trip_shape: "round_trip", trip_type: "round_trip",
      depart_at: at(1, 2, 6), return_at: at(1, 2, 10), adults: 1, child_seats: 0, boosters: 0, has_luggage: false, stops: [], ...extra,
    });
    const sub = await m1.rpc("submit_request", { payload: payload() });
    check("member files a round-trip request in an open week", !sub.error && !!sub.data?.request_id, errText(sub));
    const requestId = sub.data?.request_id;
    if (!requestId) return;
    const mine = await m1.from("requests").select("status,version,adults,depart_at,return_at,requester_id").eq("id", requestId).single();
    check("  the member reads their own request back (status submitted)", !mine.error && mine.data.status === "submitted" && mine.data.requester_id === m1Id, mine.error?.message ?? mine.data?.status);
    check("  another member cannot read it", ((await m2.from("requests").select("id").eq("id", requestId)).data ?? []).length === 0);

    const edit = await m1.rpc("submit_request", { payload: payload({ request_id: requestId, expected_version: mine.data.version, adults: 2, return_at: at(1, 2, 11) }) });
    check("member edits it with the expected version", !edit.error, errText(edit));
    const edited = await m1.from("requests").select("adults,return_at,version").eq("id", requestId).single();
    check("  edited fields stored and version bumped", edited.data?.adults === 2 && Date.parse(edited.data.return_at) === Date.parse(at(1, 2, 11)) && edited.data.version > mine.data.version,
      JSON.stringify(edited.data));
    const stale = await m1.rpc("submit_request", { payload: payload({ request_id: requestId, expected_version: mine.data.version }) });
    check("  a stale expected_version is refused", !!stale.error && /stale/.test(stale.error.message), errText(stale));
    // REQ §13.101 (h), R11B1: a save with no changes changes nothing (same payload, current version).
    const same = await m1.rpc("submit_request", { payload: payload({ request_id: requestId, expected_version: edited.data.version, adults: 2, return_at: at(1, 2, 11) }) });
    check("  a no-op resave answers unchanged:true", !same.error && same.data?.unchanged === true && same.data?.ok === true, errText(same));
    const afterSame = await m1.from("requests").select("version,updated_at,status").eq("id", requestId).single();
    check("  and changes nothing (version, updated_at, status)", afterSame.data?.version === edited.data.version && afterSame.data?.status === "submitted", JSON.stringify(afterSame.data));
    const probe = await m1.rpc("submit_request", { payload: payload({ request_id: requestId, expected_version: edited.data.version, adults: 2, return_at: at(1, 2, 11), probe_only: true }) });
    check("  a probe reports unchanged", !probe.error && probe.data?.unchanged === true, errText(probe));
    const other = await m2.rpc("submit_request", { payload: payload({ request_id: requestId, expected_version: edited.data.version }) });
    check("  another member cannot edit it", !!other.error, errText(other));

    const wd = await m1.rpc("withdraw_request", { p_request_id: requestId, p_expected_version: edited.data.version });
    check("member withdraws the request", !wd.error, wd.error?.message);
    check("  status is withdrawn", (await reqRow(requestId)).status === "withdrawn");
  });

  // ------------------------------------------------------------------ proposals: merge and shift, send, answer
  await section("proposal: Sadran merge + shift -> send -> members answer in-app -> applied", async () => {
    await mkWeek(2, "solving");
    // merge m2's leftover request into m1's ride
    const host = await ride({ n: 2, car: CAR_A, day: 1, driver: m1Id });
    const qHost = await request({ n: 2, requester: m1Id, day: 1, status: "assigned" }); await link(host.id, qHost, "driver", "keep");
    const qGuest = await request({ n: 2, requester: m2Id, day: 1, status: "waitlisted" });
    const mergePayload = { ride_id: host.id, legs: [{ ride_id: host.id, role: "passenger", leg: "both", car_mode: "passenger" }] };

    const denied = await m2.rpc("create_proposal", { p_request_id: qGuest, p_ride_id: host.id, p_type: "merge", p_payload: mergePayload, p_reason_he: "api test", p_party_profile_ids: [], p_created_via: "sadran" });
    check("a plain member cannot create a Sadran proposal", !!denied.error && /not_authorized/.test(denied.error.message), errText(denied));

    const created = await sadran.rpc("create_proposal", { p_request_id: qGuest, p_ride_id: host.id, p_type: "merge", p_payload: mergePayload, p_reason_he: "api test", p_party_profile_ids: [], p_created_via: "sadran" });
    check("Sadran drafts a merge proposal", !created.error && !!created.data, errText(created));
    const mergeId = created.data;
    if (mergeId) {
      const draft = await sadran.from("proposals").select("status,type").eq("id", mergeId).single();
      check("  proposal is a merge draft", draft.data?.status === "draft" && draft.data?.type === "merge", JSON.stringify(draft.data ?? draft.error));
      const parties = (await sadran.from("proposal_parties").select("profile_id").eq("proposal_id", mergeId)).data ?? [];
      check("  parties are the guest and the host driver", [m1Id, m2Id].every((p) => parties.some((x) => x.profile_id === p)), JSON.stringify(parties));

      const memberSend = await m2.rpc("send_proposal", { p_proposal_id: mergeId, p_sent_via: [] });
      check("  a plain member cannot send it", !!memberSend.error && /not_authorized/.test(memberSend.error.message), errText(memberSend));
      const sent = await sadran.rpc("send_proposal", { p_proposal_id: mergeId, p_sent_via: [] });
      check("Sadran sends it", !sent.error && !!sent.data?.party_tokens, errText(sent));
      const tokens = sent.data?.party_tokens ?? {};
      check("  request is now proposed", (await reqRow(qGuest)).status === "proposed");
      const seen = await m2.from("proposal_parties").select("response,proposal_id").eq("proposal_id", mergeId).eq("profile_id", m2Id).maybeSingle();
      check("  the guest sees their party row (pending)", seen.data?.response === "pending", JSON.stringify(seen.data ?? seen.error));

      const a1 = await m2.rpc("answer_proposal", { p_token: tokens[m2Id], p_accept: true, p_via: "session" });
      check("guest accepts in-app", !a1.error, a1.error?.message);
      check("  not applied until the host driver answers", (await reqRow(qGuest)).status !== "merged");
      const a2 = await m1.rpc("answer_proposal", { p_token: tokens[m1Id], p_accept: true, p_via: "session" });
      check("host driver accepts in-app", !a2.error, a2.error?.message);
      const after = await reqRow(qGuest);
      check("  guest request is merged onto the ride", after.status === "merged", `${after.status}/${after.status_reason}`);
      const links = must(await svc.from("ride_requests").select("role").eq("ride_id", host.id).eq("request_id", qGuest), "links");
      check("  ride_requests links the guest as passenger", links.length === 1 && links[0].role === "passenger", JSON.stringify(links));
      const prop = must(await svc.from("proposals").select("status").eq("id", mergeId).single(), "proposal").status;
      check("  proposal is applied", prop === "applied", prop);
      const replay = await m1.rpc("answer_proposal", { p_token: tokens[m1Id], p_accept: false, p_via: "session" });
      check("  answering again is refused", !!replay.error, errText(replay));
    }

    // shift m2's other request to a free car at a new time
    const qShift = await request({ n: 2, requester: m2Id, day: 3, status: "waitlisted" });
    const shiftPayload = { car_id: CAR_B, depart_at: at(2, 3, 11), return_at: at(2, 3, 15) };
    const shift = await sadran.rpc("create_proposal", { p_request_id: qShift, p_ride_id: null, p_type: "shift", p_payload: shiftPayload, p_reason_he: "api test", p_party_profile_ids: [], p_created_via: "sadran" });
    check("Sadran drafts a shift proposal", !shift.error && !!shift.data, errText(shift));
    if (shift.data) {
      const sent = await sadran.rpc("send_proposal", { p_proposal_id: shift.data, p_sent_via: [] });
      check("  Sadran sends the shift", !sent.error && !!sent.data?.party_tokens, errText(sent));
      const ans = await m2.rpc("answer_proposal", { p_token: sent.data?.party_tokens?.[m2Id], p_accept: true, p_via: "session" });
      check("  requester accepts in-app", !ans.error, ans.error?.message);
      const q = await reqRow(qShift);
      check("  request is assigned", q.status === "assigned", `${q.status}/${q.status_reason}`);
      const rr = must(await svc.from("ride_requests").select("rides(car_id,starts_at,ends_at,status)").eq("request_id", qShift), "ride link");
      const rd = rr[0]?.rides;
      check("  on the proposed car at the proposed time", rr.length === 1 && rd.car_id === CAR_B && rd.status !== "cancelled"
        && Date.parse(rd.starts_at) === Date.parse(shiftPayload.depart_at) && Date.parse(rd.ends_at) === Date.parse(shiftPayload.return_at), JSON.stringify(rr));
    }
  });

  // ------------------------------------------------- publish, member reads, then ride-level member/Sadran actions
  await section("publish: publish_siddur -> plain member reads the rides (RLS); negatives", async () => {
    const wk = await mkWeek(3, "solving");
    const day = 2; const date = dayDate(3, day);
    const rA = await ride({ n: 3, car: CAR_A, day, driver: m1Id, status: "draft" });
    const qA = await request({ n: 3, requester: m1Id, day, status: "assigned" }); await link(rA.id, qA, "driver", "keep");
    const rB = await ride({ n: 3, car: CAR_B, day, driver: m2Id, status: "draft" });
    const qB = await request({ n: 3, requester: m2Id, day, status: "assigned" }); await link(rB.id, qB, "driver", "keep");

    const before = (await m2.from("rides").select("id").eq("week_start", wk)).data ?? [];
    check("before publishing a member sees none of the week's rides", before.length === 0, String(before.length));
    const fpMember = await m2.rpc("publish_scores_fingerprint", { p_department_id: DEPT, p_week_start: wk });
    const fp = await sadran.rpc("publish_scores_fingerprint", { p_department_id: DEPT, p_week_start: wk });
    check("Sadran reads the publication fingerprint", !fp.error && !!fp.data, errText(fp));
    const denied = await m2.rpc("publish_siddur", { p_department_id: DEPT, p_week_start: wk, p_profile_scores: [], p_expected_fingerprint: fp.data ?? fpMember.data, p_policy_scores: [], p_days: [date] });
    check("a plain member cannot publish", !!denied.error && /not_authorized/.test(denied.error.message), errText(denied));
    check("  nothing was published", (await rideRow(rA.id)).status === "draft");

    const pub = await sadran.rpc("publish_siddur", { p_department_id: DEPT, p_week_start: wk, p_profile_scores: [], p_expected_fingerprint: fp.data, p_policy_scores: [], p_days: [date], p_allow_unanswered: false });
    check("Sadran publishes the day", !pub.error && !!pub.data, errText(pub));
    const wRow = must(await svc.from("weeks").select("phase,published_days").eq("week_start", wk).eq("department_id", DEPT).single(), "week");
    check("  week is published with that day public", wRow.phase === "published" && wRow.published_days.includes(date), JSON.stringify(wRow));
    const after = (await m2.from("rides").select("id,status").eq("week_start", wk)).data ?? [];
    check("  a plain member now reads both rides", after.length === 2 && after.every((r) => r.status === "confirmed"), JSON.stringify(after));
    const board = (await m2.from("v_board_rides").select("id").eq("week_start", wk)).data ?? [];
    check("  and the siddur view", board.length === 2, String(board.length));

    // -- ride-level actions on the published day -------------------------------------------------------------------
    // add_ride_passengers / remove_ride_person
    {
      const add = await m2.rpc("add_ride_passengers", { p_ride_id: rA.id, p_expected_version: await version(rA.id), p_passengers: [{ display_name: "API Guest", seat_kind: "adult" }] });
      check("member adds a named guest to someone's published ride", !add.error, add.error?.message);
      const rows = must(await svc.from("ride_passengers").select("id,display_name").eq("ride_id", rA.id), "passengers");
      check("  ride_passengers holds the guest", rows.length === 1 && rows[0].display_name === "API Guest", JSON.stringify(rows));
      if (rows[0]) {
        const rem = await m2.rpc("remove_ride_person", { p_ride_id: rA.id, p_expected_version: await version(rA.id), p_key: `added:${rows[0].id}` });
        check("member removes the guest again", !rem.error, rem.error?.message);
        check("  ride_passengers is empty", must(await svc.from("ride_passengers").select("id").eq("ride_id", rA.id), "passengers").length === 0);
      }
      const stale = await m2.rpc("add_ride_passengers", { p_ride_id: rA.id, p_expected_version: 0, p_passengers: [{ display_name: "API Guest", seat_kind: "adult" }] });
      check("  a stale ride version is refused", !!stale.error && /stale/.test(stale.error.message), errText(stale));
    }

    // swap_day_cars by a member
    {
      const prev = await m2.rpc("preview_day_car_swap", { p_department_id: DEPT, p_week_start: wk, p_day: date, p_car_a: CAR_A, p_car_b: CAR_B });
      check("member previews swapping two cars' rides for the day", !prev.error && prev.data?.can_swap === true, prev.error?.message ?? JSON.stringify(prev.data?.blockers));
      const swap = await m2.rpc("swap_day_cars", { p_department_id: DEPT, p_week_start: wk, p_day: date, p_car_a: CAR_A, p_car_b: CAR_B, p_expected_fingerprint: prev.data?.fingerprint, p_series_mode: "whole" });
      check("member swaps the two cars for the day", !swap.error && swap.data?.moved_rides === 2, swap.error?.message ?? JSON.stringify(swap.data));
      const [a, b] = [await rideRow(rA.id), await rideRow(rB.id)];
      check("  each ride is on the other car", a.car_id === CAR_B && b.car_id === CAR_A, `${a.car_id} / ${b.car_id}`);
      const stale = await m2.rpc("swap_day_cars", { p_department_id: DEPT, p_week_start: wk, p_day: date, p_car_a: CAR_A, p_car_b: CAR_B, p_expected_fingerprint: prev.data?.fingerprint, p_series_mode: "whole" });
      check("  swapping on a stale fingerprint is refused", !!stale.error && /stale/.test(stale.error.message), errText(stale));
    }

    // mark_car_move
    {
      const move = { p_car_id: CAR_B, p_from_place: HOME, p_to_place: DEST, p_at: at(3, 5, 12), p_minutes: 60 };
      const denied = await m2.rpc("mark_car_move", move);
      check("a plain member cannot mark a car move", !!denied.error && /not_authorized/.test(denied.error.message), errText(denied));
      const ok = await sadran.rpc("mark_car_move", move);
      check("Sadran marks a car move", !ok.error && !!ok.data, errText(ok));
      if (ok.data) {
        const r = await rideRow(ok.data);
        check("  it is a location-deciding move ride from home to the destination", r.auto_relocation === true && r.pin_reason === "CAR_MOVE" && r.origin_id === HOME && r.destination_id === DEST && r.car_id === CAR_B,
          JSON.stringify({ a: r.auto_relocation, p: r.pin_reason, o: r.origin_id, d: r.destination_id }));
      }
    }

    // set_ride_driver on a driverless ride
    {
      const dr = await ride({ n: 3, car: CAR_A, day: 4, needsDriver: true });
      const denied = await m2.rpc("set_ride_driver", { p_ride_id: dr.id, p_driver_id: m1Id, p_expected_version: dr.version });
      check("a plain member cannot assign a driver", !!denied.error && /not_authorized/.test(denied.error.message), errText(denied));
      const ok = await sadran.rpc("set_ride_driver", { p_ride_id: dr.id, p_driver_id: m1Id, p_expected_version: dr.version });
      check("Sadran assigns a volunteer driver", !ok.error && ok.data?.driver_id === m1Id, ok.error?.message ?? JSON.stringify(ok.data));
      const r = await rideRow(dr.id);
      check("  ride has the driver and no longer needs one", r.driver_id === m1Id && r.needs_driver === false && r.status === "confirmed", `${r.driver_id}/${r.needs_driver}/${r.status}`);
    }
  });

  // ---------------------------------------------------------------------------------- freed slot on a published day
  await section("freed: cancelled ride on a published day -> offer -> member claims -> Sadran approves", async () => {
    await mkPublishedWeek(4);
    const r = await ride({ n: 4, car: CAR_A, day: 2, driver: m1Id });
    const qd = await request({ n: 4, requester: m1Id, day: 2, status: "assigned" }); await link(r.id, qd, "driver", "keep");
    const qw = await request({ n: 4, requester: m2Id, day: 2, status: "waitlisted" });
    const qw2 = await request({ n: 4, requester: sadranId, day: 2, status: "waitlisted" });

    const cancel = await m1.rpc("cancel_ride", { p_ride_id: r.id, p_reason: "api test freed", p_expected_version: await version(r.id) });
    check("driver cancels a ride on a published day", !cancel.error, cancel.error?.message);
    const offer = must(await svc.from("freed_slot_offers").select("id,status,car_id").eq("cancelled_ride_id", r.id).maybeSingle(), "offer");
    check("  a freed-slot offer opens for that car", !!offer && offer.car_id === CAR_A, JSON.stringify(offer));
    if (!offer) return;
    const cands = must(await svc.rpc("freed_slot_candidates", { _offer: offer.id }), "candidates");
    check("  both waitlisted requests are candidates", [qw, qw2].every((q) => cands.some((c) => c.request_id === q)), JSON.stringify(cands));
    // The on-ride-cancelled edge function ranks the candidates and calls resolve_freed_offer as the service role.
    if ((await svc.from("freed_slot_offers").select("status").eq("id", offer.id).single()).data.status === "open") {
      must(await svc.rpc("resolve_freed_offer", { p_offer_id: offer.id, p_ranked_candidates: cands.map((c) => ({ request_id: c.request_id, requester_id: c.requester_id })) }), "resolve");
    }
    const mine = await m2.from("freed_slot_claims").select("status").eq("offer_id", offer.id).eq("request_id", qw).maybeSingle();
    check("  the member is offered the slot", mine.data?.status === "offered", JSON.stringify(mine.data ?? mine.error));
    const claim = await m2.rpc("claim_freed_slot", { p_offer_id: offer.id, p_request_id: qw });
    check("member claims it", !claim.error, claim.error?.message);
    check("  claim is recorded", (await m2.from("freed_slot_claims").select("status").eq("offer_id", offer.id).eq("request_id", qw).single()).data?.status === "claimed");
    const foreign = await m1.rpc("claim_freed_slot", { p_offer_id: offer.id, p_request_id: qw });
    check("  another member cannot claim on their behalf", !!foreign.error && /not_authorized/.test(foreign.error.message), errText(foreign));
    const memberApprove = await m2.rpc("approve_claim", { p_offer_id: offer.id, p_request_id: qw });
    check("  a plain member cannot approve a claim", !!memberApprove.error && /not_authorized/.test(memberApprove.error.message), errText(memberApprove));
    const approve = await sadran.rpc("approve_claim", { p_offer_id: offer.id, p_request_id: qw });
    check("Sadran approves the claim", !approve.error && !!approve.data, errText(approve));
    const q = await reqRow(qw);
    check("  the claiming request is assigned", q.status === "assigned", `${q.status}/${q.status_reason}`);
    const mineRide = await m2.from("rides").select("id,car_id,status").eq("id", approve.data).maybeSingle();
    check("  and the member reads the new ride on the freed car", mineRide.data?.car_id === CAR_A && mineRide.data?.status !== "cancelled", JSON.stringify(mineRide.data ?? mineRide.error));
    const other = must(await svc.from("freed_slot_claims").select("status").eq("offer_id", offer.id).eq("request_id", qw2).single(), "other claim");
    check("  the other candidate is declined", other.status === "declined", other.status);
    check("  offer is approved", must(await svc.from("freed_slot_offers").select("status").eq("id", offer.id).single(), "offer").status === "approved");

    // one candidate only: the slot is assigned straight away (what the edge function does for a single waitlisted request)
    const r2 = await ride({ n: 4, car: CAR_B, day: 3, driver: m1Id });
    const qd2 = await request({ n: 4, requester: m1Id, day: 3, status: "assigned" }); await link(r2.id, qd2, "driver", "keep");
    const qSolo = await request({ n: 4, requester: m2Id, day: 3, status: "waitlisted" });
    const cancel2 = await m1.rpc("cancel_ride", { p_ride_id: r2.id, p_reason: "api test freed solo", p_expected_version: await version(r2.id) });
    check("driver cancels a second ride; one waitlisted request fits", !cancel2.error, cancel2.error?.message);
    const offer2 = must(await svc.from("freed_slot_offers").select("id,status").eq("cancelled_ride_id", r2.id).maybeSingle(), "offer2");
    if (offer2) {
      if (offer2.status === "open") {
        const c2 = must(await svc.rpc("freed_slot_candidates", { _offer: offer2.id }), "candidates2");
        must(await svc.rpc("resolve_freed_offer", { p_offer_id: offer2.id, p_ranked_candidates: c2.map((c) => ({ request_id: c.request_id, requester_id: c.requester_id })) }), "resolve2");
      }
      check("  the lone candidate is assigned the car", (await reqRow(qSolo)).status === "assigned");
      const told = must(await svc.from("notifications").select("id").eq("recipient_id", m2Id).eq("event", "freed_slot_auto").eq("week_start", weekStart(4)), "notice").length;
      check("  and told about it", told === 1, String(told));
    } else check("  a freed-slot offer opens for the second car", false, "no offer");
  });

  // ---------------------------------------------------------------- multi-day request on a published week, then shorten
  await section("series: multi-day request auto-placed -> member shortens it", async () => {
    const wk = await mkPublishedWeek(5);
    const sub = await m2.rpc("submit_series_request", { payload: {
      department_id: DEPT, week_start: wk, destination_id: DEST, ride_type_id: TYPE, trip_shape: "round_trip", depart_at: at(5, 1, 6), return_at: at(5, 3, 10),
      adults: 1, child_seats: 0, boosters: 0, has_luggage: false, stops: [],
    } });
    check("member files a 3-day request on a published week", !sub.error && sub.data?.request_ids?.length === 3, errText(sub));
    const ids = sub.data?.request_ids ?? [];
    if (ids.length !== 3) return;
    const placed = must(await svc.from("requests").select("status,series_index").in("id", ids), "series");
    check("  every day is placed on a car", placed.every((p) => p.status === "assigned"), JSON.stringify(placed));
    const shorten = await m2.rpc("shorten_series", { p_request_id: ids[0], p_depart_at: at(5, 1, 6), p_return_at: at(5, 2, 10) });
    check("member shortens it to two days", !shorten.error, shorten.error?.message);
    const left = must(await svc.from("requests").select("status,series_index").in("id", ids), "series after");
    const live = left.filter((p) => !["withdrawn", "cancelled"].includes(p.status));
    check("  two days stay placed, the last one is dropped", live.length === 2 && live.every((p) => p.status === "assigned"), JSON.stringify(left));
    const stranger = await m1.rpc("shorten_series", { p_request_id: ids[0], p_depart_at: at(5, 1, 6), p_return_at: at(5, 1, 10) });
    check("  another member cannot shorten it", !!stranger.error && /not_authorized/.test(stranger.error.message), errText(stranger));
  });

  // -------------------------------------------------------------------- "be back on time" neighbours (REQ 13.108 f)
  await section("neighbours: a member reads v_ride_car_neighbours for a published ride", async () => {
    const wk = await mkWeek(6, "solving");
    const day = 2; const date = dayDate(6, day);
    const rA = await ride({ n: 6, car: CAR_A, day, driver: m1Id, status: "draft" });
    const qA = await request({ n: 6, requester: m1Id, day, status: "assigned" }); await link(rA.id, qA, "driver", "keep");
    const rB = must(await svc.from("rides").insert({
      department_id: DEPT, week_start: wk, car_id: CAR_A, starts_at: at(6, day, 10, 30), ends_at: at(6, day, 12), origin_id: HOME, destination_id: HOME,
      driver_id: m2Id, status: "draft", is_pinned: true, pin_reason: "SADRAN_MANUAL", created_by: sadranId,
    }).select("id").single(), "insert next ride");
    const qB = await request({ n: 6, requester: m2Id, day, status: "assigned" }); await link(rB.id, qB, "driver", "keep");
    const hidden = await m1.from("v_ride_car_neighbours").select("ride_id").eq("ride_id", rA.id);
    check("before publishing the member gets no neighbour row", !hidden.error && hidden.data.length === 0, errText(hidden));
    const fp = must(await sadran.rpc("publish_scores_fingerprint", { p_department_id: DEPT, p_week_start: wk }), "fingerprint");
    const pub = await sadran.rpc("publish_siddur", { p_department_id: DEPT, p_week_start: wk, p_profile_scores: [], p_expected_fingerprint: fp, p_policy_scores: [], p_days: [date], p_allow_unanswered: false });
    check("Sadran publishes the day", !pub.error && !!pub.data, errText(pub));
    const mine = await m1.from("v_ride_car_neighbours").select("*").eq("ride_id", rA.id).single();
    check("a member reads the neighbours of a published ride (grant + RLS)", !mine.error, errText(mine));
    check("  the next ride is another member's, 30 minutes later: tight", mine.data?.next_ride_id === rB.id && mine.data.next_tight === true && mine.data.next_gap_minutes === 30 && mine.data.next_kind === "ride", JSON.stringify(mine.data));
    check("  the next ride's people include its driver", Array.isArray(mine.data?.next_people) && mine.data.next_people.includes(m2Id), JSON.stringify(mine.data?.next_people));
    const mirror = await m2.from("v_ride_car_neighbours").select("prev_ride_id,prev_tight,prev_people").eq("ride_id", rB.id).single();
    check("  the next ride's driver gets the mirror fields", !mirror.error && mirror.data.prev_ride_id === rA.id && mirror.data.prev_tight === true && mirror.data.prev_people.includes(m1Id), JSON.stringify(mirror.data ?? errText(mirror)));
  });

  // ------------------------------------------------ request lifecycle (REQ 13.109 d/e/f: R7B9, R6B7, R7B12, R6B8)
  await section("lifecycle: cancel a drop-off with a guest, refusals, driver replacement", async () => {
    const wk = await mkPublishedWeek(8);   // R8B7: notices about a ride exist only for published days
    {
      const q1 = must(await svc.from("requests").insert({
        department_id: DEPT, week_start: wk, requester_id: m1Id, filed_by: sadranId, destination_id: DEST, ride_type_id: TYPE,
        depart_at: at(8, 1, 6), return_at: at(8, 1, 10), trip_shape: "round_trip", trip_type: "drop_off", needs_car_at_destination: false, status: "assigned",
      }).select("id").single(), "drop-off request").id;
      const q2 = must(await svc.from("requests").insert({
        department_id: DEPT, week_start: wk, requester_id: m2Id, filed_by: sadranId, destination_id: DEST, ride_type_id: TYPE,
        depart_at: at(8, 1, 6), trip_shape: "one_way_to", one_way_car_mode: "passenger", status: "merged",
      }).select("id").single(), "guest request").id;
      const rOut = await ride({ n: 8, car: CAR_A, day: 1, driver: m1Id, origin: HOME, destination: DEST, hour: 6, endHour: 7 });
      const rRet = await ride({ n: 8, car: CAR_A, day: 1, driver: m1Id, origin: DEST, destination: HOME, hour: 9, endHour: 10 });
      must(await svc.from("ride_requests").insert([
        { ride_id: rOut.id, request_id: q1, role: "driver", leg: "out", car_mode: "relay" },
        { ride_id: rRet.id, request_id: q1, role: "driver", leg: "return", car_mode: "relay" },
        { ride_id: rOut.id, request_id: q2, role: "passenger", leg: "out", car_mode: "passenger" },
      ]), "links");
      const res = await m1.rpc("cancel_ride", { p_ride_id: rRet.id, p_reason: "api test dropoff", p_expected_version: await version(rRet.id) });
      check("member cancels the return ride of his drop-off", !res.error, res.error?.message);
      check("  the request is cancelled", (await reqRow(q1)).status === "cancelled");
      const out = await rideRow(rOut.id);
      check("  the outbound ride is released: it survives for the guest and needs a driver", out.status !== "cancelled" && out.needs_driver === true && out.driver_id === null, JSON.stringify([out.status, out.needs_driver, out.driver_id]));
      const told = must(await svc.from("notifications").select("id").eq("recipient_id", m2Id).eq("data->>ride_id", rOut.id), "guest notices").length;
      check("  the merged guest is told", told >= 1, String(told));
      const un = await sadran.rpc("unassign_ride", { p_ride_id: rOut.id, p_expected_version: out.version });
      check("  the Sadran can unassign the released outbound ride", !un.error, un.error?.message);
    }
    {
      const ownRide = await ride({ n: 8, car: CAR_B, day: 3, driver: m1Id });
      const own = await m1.rpc("submit_request", { payload: { department_id: DEPT, week_start: wk, destination_id: DEST, ride_type_id: TYPE, trip_shape: "round_trip", depart_at: at(8, 3, 6), return_at: at(8, 3, 10), join_ride_id: ownRide.id } });
      check("asking to join your own ride is refused", !!own.error && /join_own_ride/.test(own.error.message), errText(own));
      const same = await m1.rpc("submit_request", { payload: { department_id: DEPT, week_start: wk, destination_id: DEST, origin_id: DEST, ride_type_id: TYPE, trip_shape: "round_trip", depart_at: at(8, 4, 6), return_at: at(8, 4, 10) } });
      check("origin = destination is refused", !!same.error && /origin_equals_destination/.test(same.error.message), errText(same));
    }
    {
      const r = await ride({ n: 8, car: CAR_B, day: 5, driver: m1Id });
      const q = await request({ n: 8, requester: m2Id, day: 5, status: "merged" }); await link(r.id, q, "passenger", "passenger");
      const res = await sadran.rpc("set_ride_driver", { p_ride_id: r.id, p_driver_id: sadranId, p_expected_version: r.version });
      check("Sadran replaces a volunteer driver in one step", !res.error, res.error?.message);
      check("  the ride's driver changed", (await rideRow(r.id)).driver_id === sadranId);
    }
  });
  // ------------------------------------------------ plan B (REQ 13.112 a)
  await section("planb: member files a plan B -> Sadran proposes it -> publish waits -> member accepts in-app", async () => {
    const wk = await mkWeek(9, "open", { open: true });
    const STN = "00000000-0000-0000-0000-000000000012";
    const payload = {
      department_id: DEPT, week_start: wk, destination_id: DEST, ride_type_id: TYPE, trip_shape: "round_trip", trip_type: "round_trip",
      depart_at: at(9, 2, 6), return_at: at(9, 2, 11), adults: 1, child_seats: 0, boosters: 0, has_luggage: false, stops: [],
      fallback: "alternative", alternative: { drop_place_id: STN, arrive_by: at(9, 2, 7), pickup: true, pickup_at: at(9, 2, 12) },
    };
    const sub = await m1.rpc("submit_request", { payload });
    check("member files a request with a plan B", !sub.error && !!sub.data?.request_id, errText(sub));
    const q = sub.data?.request_id;
    if (!q) return;
    check("  the member reads their plan B row", ((await m1.from("request_alternatives").select("id").eq("request_id", q)).data ?? []).length === 1);
    check("  another member cannot read it", ((await m2.from("request_alternatives").select("id").eq("request_id", q)).data ?? []).length === 0);
    check("  the Sadran reads it", ((await sadran.from("request_alternatives").select("id").eq("request_id", q)).data ?? []).length === 1);
    const direct = await m1.from("request_alternatives").update({ pickup: false, pickup_at: null }).eq("request_id", q).select("id");
    check("  nobody writes the row directly", !direct.error ? (direct.data ?? []).length === 0 : true, errText(direct));
    const bad = await m1.rpc("submit_request", { payload: { ...payload, trip_type: "drop_off", needs_car_at_destination: false } });
    check("  a הקפצה carries no fallback (fallback_not_allowed)", !!bad.error && /fallback_not_allowed/.test(bad.error.message), errText(bad));

    const p = await sadran.rpc("create_proposal", { p_request_id: q, p_ride_id: null, p_type: "alternative",
      p_payload: { car_id: CAR_A, depart_at: at(9, 2, 6, 30), return_at: at(9, 2, 12, 30) }, p_reason_he: "plan B" });
    check("Sadran drafts the alternative proposal", !p.error && !!p.data, errText(p));
    if (!p.data) return;
    const noCar = await sadran.rpc("create_proposal", { p_request_id: q, p_ride_id: null, p_type: "alternative", p_payload: { depart_at: at(9, 2, 6, 30), return_at: at(9, 2, 12, 30) }, p_reason_he: "x" });
    check("  a plan-B proposal without a car is refused (alternative_car_required), no silent pick", !!noCar.error && /alternative_car_required/.test(noCar.error.message), errText(noCar));
    const member = await m1.rpc("create_proposal", { p_request_id: q, p_ride_id: null, p_type: "alternative", p_payload: { car_id: CAR_A, depart_at: at(9, 2, 6, 30) }, p_reason_he: "x" });
    check("  a member cannot create one", !!member.error, errText(member));
    const fp = must(await sadran.rpc("publish_scores_fingerprint", { p_department_id: DEPT, p_week_start: wk }), "fingerprint");
    const pub = await sadran.rpc("publish_siddur", { p_department_id: DEPT, p_week_start: wk, p_profile_scores: [], p_expected_fingerprint: fp, p_policy_scores: [], p_days: [dayDate(9, 2)], p_allow_unanswered: true });
    check("publish refuses an unsent plan-B draft even with allow_unanswered", !!pub.error && /publication_drafts/.test(pub.error.message), errText(pub));
    const conflicts = await sadran.rpc("proposal_car_conflicts", { p_proposal_id: p.data });
    check("  the car-conflict preview answers (none)", !conflicts.error && Array.isArray(conflicts.data) && conflicts.data.length === 0, errText(conflicts));
    const sent = await sadran.rpc("send_proposal", { p_proposal_id: p.data });
    check("Sadran sends it", !sent.error && Array.isArray(sent.data?.car_conflicts), errText(sent));
    const fp2 = must(await sadran.rpc("publish_scores_fingerprint", { p_department_id: DEPT, p_week_start: wk }), "fingerprint");
    const pub2 = await sadran.rpc("publish_siddur", { p_department_id: DEPT, p_week_start: wk, p_profile_scores: [], p_expected_fingerprint: fp2, p_policy_scores: [], p_days: [dayDate(9, 2)], p_allow_unanswered: true });
    check("publish waits for a sent plan B even with allow_unanswered", !!pub2.error && /publication_alternatives_pending/.test(pub2.error.message), errText(pub2));
    const token = sent.data?.party_tokens?.[m1Id];
    const ans = await m1.rpc("answer_proposal", { p_token: token, p_accept: true, p_via: "session" });
    check("the member accepts in-app", !ans.error, errText(ans));
    const row = await reqRow(q);
    check("  the request is now served by its plan B (a הקפצה to the drop point)", row.served_by_alternative === true && row.trip_type === "drop_off" && row.destination_id === STN, JSON.stringify([row.served_by_alternative, row.trip_type, row.status]));
    const alt = must(await svc.from("request_alternatives").select("original_main,applied_at").eq("request_id", q).single(), "alt row");
    check("  the original trip is kept whole", !!alt.applied_at && alt.original_main?.trip_type === "round_trip" && alt.original_main?.destination_id === DEST);
    const edit = await m1.rpc("submit_request", { payload: { ...payload, request_id: q, expected_version: row.version } });
    check("  the served request cannot be edited", !!edit.error && /request_served_by_alternative/.test(edit.error.message), errText(edit));
  });

  await section("neutral: a notes-only edit of a placed request on a published day keeps its booking (REQ 13.101 l)", async () => {
    const wk = await mkPublishedWeek(10);
    const payload = (extra = {}) => ({
      department_id: DEPT, week_start: wk, destination_id: DEST, ride_type_id: TYPE, trip_shape: "round_trip", trip_type: "round_trip",
      depart_at: at(10, 2, 6), return_at: at(10, 2, 10), adults: 1, child_seats: 0, boosters: 0, has_luggage: false, stops: [], ...extra,
    });
    const sub = await m1.rpc("submit_request", { payload: payload() });
    check("member files a round trip on a published day and it is placed", !sub.error && sub.data?.status === "assigned", errText(sub));
    const q = sub.data?.request_id;
    if (!q) return;
    const before = await reqRow(q);
    const rideOf = async () => must(await svc.from("ride_requests").select("ride_id").eq("request_id", q).limit(1), "ride link")[0]?.ride_id;
    const rideBefore = await rideOf();
    const edit = payload({ request_id: q, expected_version: before.version, notes: "only a note" });
    const probe = await m1.rpc("submit_request", { payload: { ...edit, probe_only: true } });
    check("  the probe says placement-neutral, no booking lost", !probe.error && probe.data?.placement_neutral === true && probe.data?.would_lose_booking === false, errText(probe));
    const save = await m1.rpc("submit_request", { payload: edit });
    check("  the save answers without a confirmation", !save.error && save.data?.placement_neutral === true && !save.data?.needs_confirmation, errText(save));
    const after = await reqRow(q);
    check("  note stored; same ride, still assigned, same reason", after.notes === "only a note" && (await rideOf()) === rideBefore && after.status === "assigned" && after.status_reason === before.status_reason,
      JSON.stringify([after.notes, after.status, after.status_reason]));
  });

  await section("readiness: a day nobody solved is not ready (R8B2, REQ 13.115)", async () => {
    const wk = await mkWeek(21, "open");
    const rS = await ride({ n: 21, car: CAR_A, day: 3, driver: m1Id, status: "draft" });
    const qS = await request({ n: 21, requester: m1Id, day: 3, status: "assigned" }); await link(rS.id, qS, "driver", "keep");
    await request({ n: 21, requester: m2Id, day: 2, status: "submitted" });
    await request({ n: 21, requester: m2Id, day: 4, status: "waitlisted" });
    const dayOf = (rows, n) => rows.find((r) => r.day === dayDate(21, n));
    const denied = await m1.rpc("publication_readiness", { p_department_id: DEPT, p_week_start: wk });
    check("a plain member cannot read the readiness", !!denied.error && /not_authorized/.test(denied.error.message), errText(denied));
    const res = await sadran.rpc("publication_readiness", { p_department_id: DEPT, p_week_start: wk });
    check("Sadran reads the readiness", !res.error && Array.isArray(res.data), errText(res));
    const rows = res.data ?? [];
    check("  the day with a submitted request: unsolved 1, not ready", dayOf(rows, 2)?.unsolvedRequests === 1 && dayOf(rows, 2)?.ready === false, JSON.stringify(dayOf(rows, 2)));
    check("  the solved day (placed request) is ready", dayOf(rows, 3)?.unsolvedRequests === 0 && dayOf(rows, 3)?.ready === true, JSON.stringify(dayOf(rows, 3)));
    check("  a waitlisted (solver-unmet) request counts as solved, informational only", dayOf(rows, 4)?.unsolvedRequests === 0 && dayOf(rows, 4)?.ready === true, JSON.stringify(dayOf(rows, 4)));
  });

  await section("publish: driverless rides need the confirmation flag; conflicts are named (R12M3, R12B6, REQ 13.120)", async () => {
    const wk = await mkWeek(71, "solving");
    const date = dayDate(71, 3);
    const rD = await ride({ n: 71, car: CAR_A, day: 3, driver: null, needsDriver: true, status: "flagged" });
    const denied = await m1.rpc("publication_conflicts", { p_department_id: DEPT, p_week_start: wk, p_days: [date] });
    check("a plain member cannot read the publication conflicts", !!denied.error && /not_authorized/.test(denied.error.message), errText(denied));
    const named = await sadran.rpc("publication_conflicts", { p_department_id: DEPT, p_week_start: wk, p_days: [date] });
    check("Sadran reads the conflicts (none for a driverless-only day)", !named.error && Array.isArray(named.data) && named.data.length === 0, errText(named));
    const rd = (await sadran.rpc("publication_readiness", { p_department_id: DEPT, p_week_start: wk })).data?.find((r) => r.day === date);
    check("  the driverless day is still ready, the ride is counted", rd?.ready === true && rd?.missingDriverRides === 1, JSON.stringify(rd));
    const fp = await sadran.rpc("publish_scores_fingerprint", { p_department_id: DEPT, p_week_start: wk });
    const publish = (extra) => sadran.rpc("publish_siddur", { p_department_id: DEPT, p_week_start: wk, p_profile_scores: [], p_expected_fingerprint: fp.data, p_policy_scores: [], p_days: [date], ...extra });
    const refused = await publish({});
    check("publishing without the flag is refused with publication_driverless", !!refused.error && /publication_driverless/.test(refused.error.message), errText(refused));
    const ok = await publish({ p_allow_driverless: true });
    check("with p_allow_driverless the day publishes and the ride keeps NEEDS_DRIVER", !ok.error && (await rideRow(rD.id)).needs_driver === true, errText(ok));
  });

  await section("ask-to-join: private car owner gets the proposal, shared-ride driver is told (R8B5, R8M1, REQ 13.116)", async () => {
    const wk = await mkPublishedWeek(31);
    const CAR_PRIVATE = "00000000-0000-0000-0000-000000000043"; // m2's own temporary car
    const rPriv = await ride({ n: 31, car: CAR_PRIVATE, day: 2, driver: m2Id });
    const joinPayload = (rideId, day) => ({ department_id: DEPT, week_start: wk, destination_id: DEST, ride_type_id: TYPE, trip_shape: "round_trip", depart_at: at(31, day, 6), return_at: at(31, day, 10), join_ride_id: rideId });
    const ask = await m1.rpc("submit_request", { payload: joinPayload(rPriv.id, 2) });
    check("member asks to join a private car", !ask.error, errText(ask));
    const prop = must(await svc.from("proposals").select("id,status,sent_at,created_via").eq("request_id", ask.data?.request_id).eq("created_via", "ask_to_join"), "proposal");
    check("  the proposal is SENT to the owner (not a draft)", prop.length === 1 && prop[0].status === "sent" && !!prop[0].sent_at, JSON.stringify(prop));
    const told = must(await svc.from("notifications").select("id").eq("recipient_id", m2Id).eq("event", "proposal_received").eq("data->>proposal_id", prop[0]?.id), "owner notice").length;
    check("  the owner is notified", told === 1, String(told));
    const rShared = await ride({ n: 31, car: CAR_B, day: 3, driver: m2Id });
    const ask2 = await m1.rpc("submit_request", { payload: joinPayload(rShared.id, 3) });
    check("member asks to join a shared ride", !ask2.error, errText(ask2));
    const driverTold = must(await svc.from("notifications").select("id,title_he").eq("recipient_id", m2Id).eq("data->>variant", "join_asked").eq("data->>ride_id", rShared.id), "driver notice");
    check("  the driver is told someone asks to join", driverTold.length === 1 && /להצטרף/.test(driverTold[0].title_he), JSON.stringify(driverTold));
  });

  await section("trip type: the Sadran switches an unplaced request to a drop-off and a free car takes it (R8B12, REQ 13.117)", async () => {
    await mkWeek(41, "open");
    const q = await request({ n: 41, requester: m1Id, day: 2, status: "submitted" });
    const before = await reqRow(q);
    const denied = await m1.rpc("set_request_trip_type", { p_request_id: q, p_trip_type: "drop_off", p_expected_version: before.version });
    check("a plain member cannot switch another request's trip type", !!denied.error, errText(denied));
    const res = await sadran.rpc("set_request_trip_type", { p_request_id: q, p_trip_type: "drop_off", p_expected_version: before.version });
    check("Sadran switches it to a drop-off", !res.error && res.data?.changed === true, errText(res));
    const rides = must(await svc.from("ride_requests").select("leg,car_mode,rides!inner(status,car_id)").eq("request_id", q), "rides of the request")
      .filter((r) => r.rides.status !== "cancelled");
    check("  it was placed on a free shared car (no longer unmet)", !!res.data?.ride_id && rides.length >= 1, JSON.stringify([res.data, rides]));
    const after = await reqRow(q);
    check("  the new trip type is stored and the request is not 'submitted' any more", after.trip_type === "drop_off" && after.status !== "submitted", JSON.stringify([after.trip_type, after.status, after.status_reason]));
  });

  await section("maintenance: the responsible member creates and shortens a period, a plain member is refused (P6, REQ 13.114)", async () => {
    const wk = await mkPublishedWeek(51);
    const carBefore = must(await svc.from("cars").select("responsible_id").eq("id", CAR_A).single(), "car").responsible_id;
    const blockIds = [];
    try {
      must(await svc.from("cars").update({ responsible_id: m1Id }).eq("id", CAR_A), "make m1 responsible for car A");
      const denied = await m2.rpc("create_car_maintenance", { p_car_id: CAR_A, p_starts_at: at(51, 2, 6), p_ends_at: at(51, 2, 12) });
      check("a plain member cannot create a period", !!denied.error && /not_authorized/.test(denied.error.message), errText(denied));
      const directWrite = await m2.from("car_maintenance_blocks").insert({ car_id: CAR_A, department_id: DEPT, starts_at: at(51, 2, 6), ends_at: at(51, 2, 12), reason: "x", created_by: m2Id });
      check("  nor write the table directly", !!directWrite.error, errText(directWrite));
      const made = await m1.rpc("create_car_maintenance", { p_car_id: CAR_A, p_starts_at: at(51, 2, 6), p_ends_at: at(51, 2, 12) });
      check("the responsible member creates a period", !made.error && !!made.data, errText(made));
      const blockId = made.data; blockIds.push(blockId);
      const readBack = must(await m2.from("car_maintenance_blocks").select("starts_at,ends_at,created_by").eq("id", blockId).single(), "block read by another member");
      check("  other members read it (drawn on the siddur)", Date.parse(readBack.ends_at) === Date.parse(at(51, 2, 12)) && readBack.created_by === m1Id, JSON.stringify(readBack));
      const shortened = await m1.rpc("update_car_maintenance", { p_block_id: blockId, p_starts_at: at(51, 2, 6), p_ends_at: at(51, 2, 9) });
      check("  and shortens it", !shortened.error && Date.parse(must(await svc.from("car_maintenance_blocks").select("ends_at").eq("id", blockId).single(), "block").ends_at) === Date.parse(at(51, 2, 9)), errText(shortened));
      const refusedEdit = await m2.rpc("update_car_maintenance", { p_block_id: blockId, p_starts_at: at(51, 2, 6), p_ends_at: at(51, 2, 7) });
      check("a plain member cannot shorten it", !!refusedEdit.error && /not_authorized/.test(refusedEdit.error.message), errText(refusedEdit));
      const refusedDelete = await m2.rpc("delete_car_maintenance", { p_block_id: blockId });
      check("  nor remove it", !!refusedDelete.error && /not_authorized/.test(refusedDelete.error.message), errText(refusedDelete));
      // a ride after the period is flagged (and its driver told) when the period is extended over it
      const r = await ride({ n: 51, car: CAR_A, day: 2, driver: m2Id, hour: 10, endHour: 11 });
      const extended = await m1.rpc("update_car_maintenance", { p_block_id: blockId, p_starts_at: at(51, 2, 6), p_ends_at: at(51, 2, 11) });
      check("extending the period over a ride reports it", !extended.error && extended.data?.flagged_rides === 1, errText(extended));
      check("  the ride is flagged for maintenance", (await rideRow(r.id)).status === "flagged" && (await rideRow(r.id)).flag_reason === "maintenance");
      const told = must(await svc.from("notifications").select("id").eq("recipient_id", m2Id).eq("event", "maintenance_affects").eq("data->>ride_id", r.id), "notice").length;
      check("  its driver is notified", told === 1, String(told));
      await m1.rpc("update_car_maintenance", { p_block_id: blockId, p_starts_at: at(51, 2, 6), p_ends_at: at(51, 2, 9) });
      check("  shortening back clears the flag", (await rideRow(r.id)).status === "confirmed");
      // responsibility moves: the previous responsible person loses the right, the new one gets it, whoever created the block
      must(await svc.from("cars").update({ responsible_id: m2Id }).eq("id", CAR_A), "move responsibility to m2");
      const lost = await m1.rpc("update_car_maintenance", { p_block_id: blockId, p_starts_at: at(51, 2, 6), p_ends_at: at(51, 2, 8) });
      check("the previous responsible member can no longer edit it", !!lost.error && /not_authorized/.test(lost.error.message), errText(lost));
      const gained = await m2.rpc("update_car_maintenance", { p_block_id: blockId, p_starts_at: at(51, 2, 6), p_ends_at: at(51, 2, 8) });
      check("  the current one can, although m1 created it", !gained.error, errText(gained));
      // the Sadran creates for a car nobody is responsible for; unsafe issue entry point
      const other = await sadran.rpc("create_car_maintenance", { p_car_id: CAR_B, p_starts_at: at(51, 3, 6), p_ends_at: at(51, 3, 12), p_reason: "MOT" });
      check("the Sadran creates a period for any car of the department", !other.error && !!other.data, errText(other));
      if (other.data) blockIds.push(other.data);
      const removed = await sadran.rpc("delete_car_maintenance", { p_block_id: other.data });
      check("  and removes it", !removed.error, errText(removed));
    } finally {
      await svc.from("car_maintenance_blocks").delete().in("id", blockIds);
      await svc.from("car_maintenance_blocks").delete().eq("reason", "MOT").eq("department_id", DEPT);
      await svc.from("cars").update({ responsible_id: carBefore }).eq("id", CAR_A);
    }
  });

  // ------------------------------------------------------------------ live changes (REQ 13.118, pilot fix round P4)
  await section("live: member cancels a chauffeur ride -> freed offer; volunteer replaced in one step; placed series moves all-or-nothing", async () => {
    await mkPublishedWeek(61);
    // R8B11: the passenger of a needs-driver ride cancels it -> the car is offered like any cancellation
    {
      const r = await ride({ n: 61, car: CAR_A, day: 1, needsDriver: true });
      const q = await request({ n: 61, requester: m2Id, day: 1, status: "waitlisted" }); await link(r.id, q, "passenger", "chauffeur");
      const cancel = await m2.rpc("cancel_ride", { p_ride_id: r.id, p_reason: "api test chauffeur", p_expected_version: await version(r.id) });
      check("a passenger cancels a needs-driver (chauffeur) ride", !cancel.error, errText(cancel));
      const offer = must(await svc.from("freed_slot_offers").select("id,car_id").eq("cancelled_ride_id", r.id).maybeSingle(), "offer");
      check("  the freed car is offered like any cancellation (R8B11)", !!offer && offer.car_id === CAR_A, JSON.stringify(offer));
    }
    // R8U1: replace a volunteer driver without removing first
    {
      const r = await ride({ n: 61, car: CAR_B, day: 2, needsDriver: true });
      const q = await request({ n: 61, requester: sadranId, day: 2, status: "waitlisted" }); await link(r.id, q, "passenger", "chauffeur");
      const first = await sadran.rpc("set_ride_driver", { p_ride_id: r.id, p_driver_id: m1Id, p_expected_version: await version(r.id) });
      check("the Sadran assigns a volunteer", !first.error && (await rideRow(r.id)).driver_id === m1Id, errText(first));
      const swap = await sadran.rpc("set_ride_driver", { p_ride_id: r.id, p_driver_id: m2Id, p_expected_version: await version(r.id) });
      const row = await rideRow(r.id);
      check("  replaces the volunteer in one step (R8U1)", !swap.error && row.driver_id === m2Id && !row.needs_driver && row.status === "confirmed", errText(swap));
    }
    // OB1 leftover: a placed multi-day series moves to another car on every day, or not at all
    {
      const wk = weekStart(61);
      const sub = await m2.rpc("submit_series_request", { payload: {
        department_id: DEPT, week_start: wk, destination_id: DEST, ride_type_id: TYPE, trip_shape: "round_trip", depart_at: at(61, 3, 6), return_at: at(61, 5, 10),
        adults: 1, child_seats: 0, boosters: 0, has_luggage: false, stops: [],
      } });
      const ids = sub.data?.request_ids ?? [];
      check("a 3-day request is placed on a published week", !sub.error && ids.length === 3, errText(sub));
      if (ids.length !== 3) return;
      const legs = must(await svc.from("rides").select("id,car_id,version,starts_at,ends_at,origin_id,destination_id,week_start,series_id").in("series_id", [must(await svc.from("requests").select("series_id").eq("id", ids[0]).single(), "series").series_id]).neq("status", "cancelled").order("starts_at"), "legs");
      check("  three rides on one car", legs.length === 3 && new Set(legs.map((l) => l.car_id)).size === 1, JSON.stringify(legs.map((l) => l.car_id)));
      const from = legs[0].car_id;
      const cars = must(await svc.from("cars").select("id").eq("department_id", DEPT).eq("type", "shared").eq("status", "active").neq("id", from), "cars").map((c) => c.id);
      const target = cars[0], blocker = cars[1];
      const payload = (leg, car) => ({ id: leg.id, department_id: DEPT, week_start: leg.week_start, starts_at: leg.starts_at, ends_at: leg.ends_at, origin_id: leg.origin_id, destination_id: leg.destination_id, car_id: car });
      // block the target car on the middle day with another ride: the move must refuse and leave every day where it was
      await ride({ n: 61, car: blocker, day: 4, driver: m1Id, hour: 7, endHour: 9 });
      const busy = await ride({ n: 61, car: target, day: 4, driver: m1Id, hour: 7, endHour: 9 });
      const refused = await sadran.rpc("edit_ride", { p_ride: payload(legs[0], target), p_expected_version: legs[0].version });
      const afterRefusal = must(await svc.from("rides").select("car_id").eq("series_id", legs[0].series_id).neq("status", "cancelled"), "after refusal");
      check("moving it onto a car busy on one day is refused (all-or-nothing)", !!refused.error && afterRefusal.every((r) => r.car_id === from), errText(refused));
      must(await svc.from("rides").delete().eq("id", busy.id), "free the target car");
      const moved = await sadran.rpc("edit_ride", { p_ride: payload(legs[0], target), p_expected_version: legs[0].version });
      const afterMove = must(await svc.from("rides").select("car_id").eq("series_id", legs[0].series_id).neq("status", "cancelled"), "after move");
      check("  moving it onto a free car moves every day", !moved.error && afterMove.length === 3 && afterMove.every((r) => r.car_id === target), errText(moved));
      const plain = await m1.rpc("edit_ride", { p_ride: payload(legs[1], from), p_expected_version: (await rideRow(legs[1].id)).version });
      check("  a plain member cannot move it", !!plain.error, errText(plain));
    }
  });

} finally {
  await purge([...madeWeeks]);
}
if (knownBugs.length) console.error(`\n${knownBugs.length} known application bug(s) reported by the API suite: ${knownBugs.join("; ")}`);
if (failures.length) { console.error(`\n${failures.length} API check(s) failed`); process.exit(1); }
console.log("\nAPI checks passed");
