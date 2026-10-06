#!/usr/bin/env node
// API-level suite (docs/TODO.md U1): drives real RPCs as signed-in seeded users through PostgREST, so failures that
// only appear under role grants / mandatory-WHERE guards (the SQL suites run as the database owner) are caught.
// Opt-in (`QA_API=1 QA_API_URL=<disposable api> npm run db:test`) or `node scripts/test-api.mjs`.
// Disposable local stacks only (scripts/qa/qa-common.mjs refuses :54321). Fixtures go in through the service role
// into a far-future week and are removed again.
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
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` - ${detail}`}`); if (!ok) failures.push(name); };
const must = (r, what) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };

const sadran = await signedInClient(api, "sadran@nevo.local", PW);
const m1 = await signedInClient(api, "member1@nevo.local", PW);
const m2 = await signedInClient(api, "member2@nevo.local", PW);
const id = async (c) => (await c.auth.getUser()).data.user.id;
const [sadranId, m1Id, m2Id] = [await id(sadran), await id(m1), await id(m2)];

// A Sunday ~3 years out keeps clear of seeded weeks.
const base = new Date(Date.now() + 1100 * 86400000);
base.setUTCDate(base.getUTCDate() - base.getUTCDay());
const week = base.toISOString().slice(0, 10);
const at = (dayOffset, hour) => new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + dayOffset, hour)).toISOString();

const made = { rides: [], requests: [] };
async function ride({ car, day, driver, needsDriver = false }) {
  const r = must(await svc.from("rides").insert({
    department_id: DEPT, week_start: week, car_id: car, starts_at: at(day, 6), ends_at: at(day, 10), origin_id: HOME, destination_id: HOME,
    driver_id: driver ?? null, needs_driver: needsDriver, status: needsDriver ? "flagged" : "confirmed", is_pinned: true, pin_reason: "SADRAN_MANUAL", created_by: sadranId,
  }).select("id,version").single(), "insert ride");
  made.rides.push(r.id);
  return r;
}
async function request(requester, day, status) {
  const q = must(await svc.from("requests").insert({
    department_id: DEPT, week_start: week, requester_id: requester, filed_by: sadranId, destination_id: DEST, ride_type_id: TYPE,
    depart_at: at(day, 6), return_at: at(day, 10), trip_shape: "round_trip", status,
  }).select("id").single(), "insert request");
  made.requests.push(q.id);
  return q.id;
}
const link = async (rideId, requestId, role, carMode) =>
  must(await svc.from("ride_requests").insert({ ride_id: rideId, request_id: requestId, role, leg: "both", car_mode: carMode }), "link");
const version = async (rideId) => must(await svc.from("rides").select("version").eq("id", rideId).single(), "version").version;

try {
  must(await svc.from("weeks").insert({ department_id: DEPT, week_start: week, phase: "solving", open_at: at(-20, 6), close_at: at(-19, 6), publish_at: at(-18, 6) }), "insert week");

  // 1. passenger cancels their seat on someone else's ride (R5B1)
  {
    const r = await ride({ car: CAR_A, day: 1, driver: m1Id });
    const qd = await request(m1Id, 1, "assigned"); await link(r.id, qd, "driver", "keep");
    const qp = await request(m2Id, 1, "merged"); await link(r.id, qp, "passenger", "passenger");
    const res = await m2.rpc("cancel_ride", { p_ride_id: r.id, p_reason: "api test passenger", p_expected_version: await version(r.id) });
    check("member cancels a ride as passenger", !res.error, res.error?.message);
    const st = must(await svc.from("requests").select("status").eq("id", qp).single(), "status").status;
    check("  passenger request is cancelled", st === "cancelled", st);
    const driverNotified = must(await svc.from("notifications").select("id").eq("recipient_id", m1Id).eq("data->>variant", "passenger_left").eq("data->>ride_id", r.id), "notice").length;
    check("  driver is told the passenger left", driverNotified === 1, String(driverNotified));
  }
  // 2. requester on a chauffeur ride (no driver) cancels (R5B1)
  {
    const r = await ride({ car: CAR_B, day: 2, needsDriver: true });
    const q = await request(m2Id, 2, "waitlisted"); await link(r.id, q, "passenger", "chauffeur");
    const res = await m2.rpc("cancel_ride", { p_ride_id: r.id, p_reason: "api test chauffeur", p_expected_version: await version(r.id) });
    check("member cancels a chauffeur ride as requester", !res.error, res.error?.message);
    const st = must(await svc.from("rides").select("status").eq("id", r.id).single(), "status").status;
    check("  nobody left on it: ride is cancelled", st === "cancelled", st);
  }
  // 3. the driver cancels their own ride
  {
    const r = await ride({ car: CAR_A, day: 3, driver: m1Id });
    const q = await request(m1Id, 3, "assigned"); await link(r.id, q, "driver", "keep");
    const res = await m1.rpc("cancel_ride", { p_ride_id: r.id, p_reason: "api test driver", p_expected_version: await version(r.id) });
    check("member cancels a ride as driver", !res.error, res.error?.message);
    const st = must(await svc.from("rides").select("status").eq("id", r.id).single(), "status").status;
    check("  ride is cancelled", st === "cancelled", st);
  }
  // 4. a stranger is refused
  {
    const r = await ride({ car: CAR_A, day: 4, driver: m1Id });
    const q = await request(m1Id, 4, "assigned"); await link(r.id, q, "driver", "keep");
    const res = await m2.rpc("cancel_ride", { p_ride_id: r.id, p_reason: "api test stranger", p_expected_version: await version(r.id) });
    check("a member with no part in the ride is refused", !!res.error && /not_authorized/.test(res.error.message), res.error?.message ?? "no error");
  }
} finally {
  // best-effort cleanup (service role)
  for (const t of ["notifications"]) await svc.from(t).delete().in("data->>ride_id", made.rides);
  await svc.from("ride_requests").delete().in("ride_id", made.rides);
  await svc.from("rides").delete().in("id", made.rides);
  await svc.from("requests").delete().in("id", made.requests);
  await svc.from("weeks").delete().eq("department_id", DEPT).eq("week_start", week);
}
if (failures.length) { console.error(`\n${failures.length} API check(s) failed`); process.exit(1); }
console.log("\nAPI checks passed");
