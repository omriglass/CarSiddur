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
    await mkWeek(0, "solving");
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
} finally {
  await purge([...madeWeeks]);
}
if (knownBugs.length) console.error(`\n${knownBugs.length} known application bug(s) reported by the API suite: ${knownBugs.join("; ")}`);
if (failures.length) { console.error(`\n${failures.length} API check(s) failed`); process.exit(1); }
console.log("\nAPI checks passed");
