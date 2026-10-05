// scripts/test-pairing-parity.mjs
//
// Runs the shared golden cases in supabase/tests/fixtures/one_way_pairing_cases.json
// against a REAL local Supabase Postgres, exercising the SQL half of the
// one-way relay-pair-vs-chauffeur decision (pair_one_way_legs() /
// try_widen_one_way_leg() inside assert_car_chain,
// supabase/migrations/20260916100000_car_chain_one_way_healing.sql). The TS
// half of the same fixture is exercised by
// src/solver/__tests__/oneWayPairingParity.test.ts (relay.ts's pairRelays /
// chauffeurUnpairedRelayLegs). Docs/TODO.md "Code review 2026-09-24" R11.
//
// For each case: creates the out/return one-way requests as lone chauffeur-
// shaped reservations (the real shape reserve_live_one_way_slot produces),
// on two distinct pre-existing shared cars, then calls assert_car_chain and
// reads back each request's ride_requests.role/car_mode to classify the
// outcome as 'relay_pair' | 'chauffeur'. Runs inside one outer transaction
// (begin ... rollback, never committed) with a SAVEPOINT per case so one
// case's data/errors never leak into the next.
//
// A case's own `expectedSql` in the fixture is the source of truth here
// (not the TS side's `expectedTs` -- see the fixture's `knownDivergence`
// field for cases where the two implementations genuinely disagree). A
// knownDivergence case is still checked against its own expectedSql (a
// silent behaviour change there is still news) but is reported as SKIP
// rather than PASS/FAIL so the known SQL/TS disagreement never fails CI.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const config = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');
const projectId = /^project_id\s*=\s*"([^"]+)"/m.exec(config)?.[1];
if (!projectId) throw new Error('Missing Supabase project_id');
const container = process.env.SUPABASE_DB_CONTAINER ?? `supabase_db_${projectId}`;

const fixture = JSON.parse(
  readFileSync(new URL('../supabase/tests/fixtures/one_way_pairing_cases.json', import.meta.url), 'utf8'),
);

const MARK = 'PAIRING_CASE_RESULT';

// Fixed seed identities reused from supabase/tests/car_chain_healing.sql's
// convention: department Nevo, two shared cars, three members + one
// department-member "companion".
const DEPT = "'00000000-0000-0000-0000-000000000001'";
const HOME = "'00000000-0000-0000-0000-000000000010'";
const RIDE_TYPE = "'00000000-0000-0000-0000-000000000021'";
const CAR1 = "'00000000-0000-0000-0000-000000000040'";
const CAR2 = "'00000000-0000-0000-0000-000000000041'";
const MANAGER = "'00000000-0000-0000-0000-000000000102'";
const MEMBER_OUT = "'00000000-0000-0000-0000-000000000103'";
const MEMBER_RET = "'00000000-0000-0000-0000-000000000104'";
const COMPANION = "'00000000-0000-0000-0000-000000000101'";

function header() {
  return `
create temporary table pairing_ctx (dest_a uuid, dest_b uuid, week date);

do $$
declare
  dest_a uuid; dest_b uuid; w date := public.current_week_start() + 91;
begin
  insert into public.destinations(department_id,name,zone,distance_km,travel_minutes,public_transport_score,is_approved)
    values (${DEPT}, 'Pairing Parity Dest A', 'test', 10, ${fixture.config.destinations.destA.travelMinutes}, 3, true)
    returning id into dest_a;
  insert into public.destinations(department_id,name,zone,distance_km,travel_minutes,public_transport_score,is_approved)
    values (${DEPT}, 'Pairing Parity Dest B', 'test', 15, ${fixture.config.destinations.destB.travelMinutes}, 3, true)
    returning id into dest_b;
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values (${DEPT}, w, 'solving', now() - interval '2 days', now() - interval '1 day', now() + interval '1 day');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', ${MANAGER}, 'role', 'authenticated')::text, true);
  insert into pairing_ctx values (dest_a, dest_b, w);
end $$;
`;
}

function destVar(key) {
  if (key === 'home') return 'home';
  return key === 'destB' ? 'dest_b' : 'dest_a';
}

/**
 * One leg's block: declares/fills q<which>/r<which>, and toggles does_not_drive /
 * request_companions as needed. O3 (REQ §13.93, ORIGINS_PLAN §3, 2026-10-04): each leg now
 * carries its own `origin` (default 'home', matching every pre-O3 case unchanged) and
 * `tripType` (default 'drop_off' -- the only type pair_one_way_legs()/try_widen_one_way_leg()
 * ever act on; a case may set 'one_way' to prove an explicit one-way leg is never touched).
 * The placeholder ride's own origin/destination (the "lone chauffeur reservation" shape
 * reserve_live_one_way_slot() produces) is now the request's own origin, not always home.
 */
function legSql(which, leg, caseDest) {
  const destExpr = destVar(leg.destination ?? caseDest ?? 'destA');
  const originExpr = destVar(leg.origin ?? 'home');
  const tripType = leg.tripType ?? 'drop_off';
  const isOut = which === 'out';
  const tripShape = isOut ? 'one_way_to' : 'one_way_from';
  const timeCol = isOut ? 'depart_at' : 'return_at';
  const slot = isOut ? leg.departSlot : leg.returnSlot;
  const car = isOut ? CAR1 : CAR2;
  const legLabel = isOut ? 'out' : 'return';
  const requesterVar = isOut ? 'member_out' : 'member_ret';
  const timeExpr = `(w::timestamp + (${slot}::numeric * interval '15 minutes')) at time zone 'Asia/Jerusalem'`;

  const nonDriver = leg.canDrive === false ? `update public.profiles set does_not_drive = true where id = ${requesterVar};\n  ` : '';
  const companionInsert = leg.companionCanDrive
    ? `insert into public.request_companions(request_id, profile_id) values (q${which}, companion);\n  `
    : '';

  return `
  ${nonDriver}insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, origin_id, ride_type_id, ${timeCol}, trip_shape, trip_type, one_way_car_mode, needs_car_at_destination, status)
    values (${DEPT}, w, ${requesterVar}, manager, ${destExpr}, ${originExpr}, ${RIDE_TYPE}, ${timeExpr}, '${tripShape}', '${tripType}', 'relay', false, 'submitted')
    returning id into q${which};
  ${companionInsert}select travel_minutes into ${which}_travel from public.destinations where id = ${destExpr};
  select chauffeur_dwell_minutes into ${which}_dwell from public.department_settings where department_id = ${DEPT};
  ${which}_dur := greatest(15, ceil((2 * ${which}_travel + ${which}_dwell) / 15.0)::int * 15);
  ${
    isOut
      ? `${which}_start := ${timeExpr};\n  ${which}_end := ${which}_start + make_interval(mins => ${which}_dur);`
      : `${which}_end := ${timeExpr};\n  ${which}_start := ${which}_end - make_interval(mins => ${which}_dur);`
  }
  r${which} := public.edit_ride(jsonb_build_object('department_id', ${DEPT}, 'week_start', w, 'car_id', ${car}, 'needs_driver', true,
    'origin_id', ${originExpr}, 'destination_id', ${originExpr}, 'starts_at', ${which}_start, 'ends_at', ${which}_end,
    'served', jsonb_build_array(jsonb_build_object('request_id', q${which}, 'role', 'passenger', 'leg', '${legLabel}', 'car_mode', 'chauffeur'))));
`;
}

function caseSql(c, idx) {
  const sp = `sp_${idx}`;
  const declares = [];
  const body = [];
  declares.push('home uuid; manager uuid; member_out uuid; member_ret uuid; companion uuid; w date; dest_a uuid; dest_b uuid;');
  declares.push('qout uuid; qret uuid; rout uuid; rret uuid;');
  declares.push('out_travel int; out_dwell int; out_dur int; out_start timestamptz; out_end timestamptz;');
  declares.push('ret_travel int; ret_dwell int; ret_dur int; ret_start timestamptz; ret_end timestamptz;');
  declares.push('out_role text; out_mode text; ret_role text; ret_mode text;');

  body.push(`
  home := ${HOME}; manager := ${MANAGER}; member_out := ${MEMBER_OUT}; member_ret := ${MEMBER_RET}; companion := ${COMPANION};
  select pairing_ctx.week, pairing_ctx.dest_a, pairing_ctx.dest_b into w, dest_a, dest_b from pairing_ctx;
`);

  if (c.out) body.push(legSql('out', c.out, c.destination));
  if (c.return) body.push(legSql('ret', c.return, c.destination));

  body.push(`
  -- Two passes over both cars, alternating: assert_car_chain re-runs
  -- pair_one_way_legs (dept/week-scoped, not car-scoped) every time it is
  -- called, so a call for car A can re-pair legs that a call for car B just
  -- unwound (and vice versa) before that same call's own per-car walk gets a
  -- chance to look at them again. Repeating the pair settles on the real
  -- steady state instead of an artifact of call order (see report).
  perform public.assert_car_chain(${CAR1}, w);
  perform public.assert_car_chain(${CAR2}, w);
  perform public.assert_car_chain(${CAR1}, w);
  perform public.assert_car_chain(${CAR2}, w);
  perform public.assert_car_chain(${CAR1}, w);
`);

  if (c.out) {
    body.push(`  select role, car_mode into out_role, out_mode from public.ride_requests where request_id = qout;`);
  }
  if (c.return) {
    body.push(`  select role, car_mode into ret_role, ret_mode from public.ride_requests where request_id = qret;`);
  }

  const outExpr = c.out
    ? `case when out_role = 'driver' and out_mode = 'relay' then 'relay_pair' when out_role = 'passenger' and out_mode = 'chauffeur' then 'chauffeur' else out_role || '/' || out_mode end`
    : `'n/a'`;
  const retExpr = c.return
    ? `case when ret_role = 'driver' and ret_mode = 'relay' then 'relay_pair' when ret_role = 'passenger' and ret_mode = 'chauffeur' then 'chauffeur' else ret_role || '/' || ret_mode end`
    : `'n/a'`;

  body.push(`
  raise notice '${MARK}|%|out=%|ret=%', '${c.id}', ${outExpr}, ${retExpr};
`);

  return `
savepoint ${sp};
do $$
declare
  ${declares.join('\n  ')}
begin
${body.join('\n')}
exception when others then
  raise notice '${MARK}|${c.id}|ERROR|%', sqlerrm;
end $$;
rollback to savepoint ${sp};
`;
}

const script = ['begin;', header(), ...fixture.cases.map((c, i) => caseSql(c, i)), 'rollback;'].join('\n');

const result = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres'], {
  input: script,
  encoding: 'utf8',
});

if (result.error) throw result.error;
const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
console.log(result.stdout);
if (result.stderr) console.error(result.stderr);

const observed = new Map();
const lineRe = new RegExp(`NOTICE:\\s+${MARK}\\|([^|]+)\\|(.*)$`);
for (const line of output.split('\n')) {
  const m = lineRe.exec(line.trim());
  if (!m) continue;
  const [, id, rest] = m;
  if (rest.startsWith('ERROR|')) {
    observed.set(id, { error: rest.slice('ERROR|'.length) });
    continue;
  }
  const legs = {};
  for (const part of rest.split('|')) {
    const [k, v] = part.split('=');
    legs[k] = v;
  }
  observed.set(id, legs);
}

let failures = 0;
console.log('\n--- one-way pairing parity (SQL side) ---');
for (const c of fixture.cases) {
  const obs = observed.get(c.id);
  if (!obs) {
    console.log(`FAIL  ${c.id}: no result observed (script did not reach this case)`);
    failures++;
    continue;
  }
  if (obs.error) {
    console.log(`ERROR ${c.id}: ${obs.error}`);
    failures++;
    continue;
  }
  const expected = c.expectedSql ?? {};
  const checks = [];
  let ok = true;
  for (const leg of ['out', 'return']) {
    const expectedKey = leg === 'return' ? 'ret' : 'out';
    if (!(leg in c) || c[leg] === null) continue;
    const exp = expected[leg];
    const got = obs[expectedKey];
    const pass = exp === got;
    if (!pass) ok = false;
    checks.push(`${leg}: expected=${exp} got=${got}${pass ? '' : ' <<< MISMATCH'}`);
  }
  if (ok) {
    console.log(`${c.knownDivergence ? 'SKIP ' : 'PASS '} ${c.id} (${checks.join(', ')})`);
  } else {
    console.log(`FAIL  ${c.id}${c.knownDivergence ? ' [recorded knownDivergence expectedSql no longer matches reality]' : ''} (${checks.join(', ')})`);
    failures++;
  }
}

if (result.status !== 0) {
  console.error(`\npsql exited with status ${result.status}`);
  failures++;
}

console.log(`\n${fixture.cases.length - failures}/${fixture.cases.length} cases matched their recorded expectedSql outcome.`);
if (failures > 0) {
  console.error(`test-pairing-parity: ${failures} case(s) failed or errored.`);
  process.exit(1);
}
