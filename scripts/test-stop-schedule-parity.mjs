// scripts/test-stop-schedule-parity.mjs
//
// REQ item 246 (LT1): runs the shared stop-hours cases in
// supabase/tests/fixtures/stop_schedule_cases.json against the SQL half of the
// timing rule, public._stop_schedule(), in the configured local database
// container. The TS half of the same cases is src/lib/stopSchedule.test.ts.
// Read-only (one SELECT per case). Called as the last step of db:test.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const config = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');
const projectId = /^project_id\s*=\s*"([^"]+)"/m.exec(config)?.[1];
if (!projectId) throw new Error('Missing Supabase project_id');
const container = process.env.SUPABASE_DB_CONTAINER ?? `supabase_db_${projectId}`;

const fixture = JSON.parse(
  readFileSync(new URL('../supabase/tests/fixtures/stop_schedule_cases.json', import.meta.url), 'utf8'),
);
const hm = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const travel = new Map();
for (const [a, b, m] of fixture.travel) { travel.set(`${a}|${b}`, m); travel.set(`${b}|${a}`, m); }
const minutes = (a, b) => (a === b ? 0 : travel.get(`${a}|${b}`) ?? 60);

let failed = 0;
for (const c of fixture.cases) {
  const points = c.points.map((p, i) => ({
    key: p.key,
    kind: p.kind,
    travel: i === 0 ? 0 : minutes(c.points[i - 1].place, p.place),
    stay: p.stay ?? null,
    fixed: p.fixed ? { anchor: p.fixed.anchor, at: hm(p.fixed.at), flex: p.fixed.flex } : null,
  }));
  const sql = `select public._stop_schedule('${JSON.stringify(points).replace(/'/g, "''")}'::jsonb, ${fixture.stopMinutes}, ${hm('08:00')}, false)`;
  const res = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (res.status !== 0) { console.error(`FAIL ${c.name}\n${res.stderr}`); failed++; continue; }
  const out = JSON.parse(res.stdout.trim());
  const byKey = new Map(out.points.map((p) => [p.key, p]));
  const errors = [];
  const e = c.expect;
  for (const [k, [arr, lv]] of Object.entries(e.times ?? {})) {
    const p = byKey.get(k);
    if (p?.arrive !== hm(arr) || p?.leave !== hm(lv)) errors.push(`${k}: got ${p?.arrive}/${p?.leave}, want ${hm(arr)}/${hm(lv)}`);
  }
  for (const [k, m] of Object.entries(e.stays ?? {})) if (byKey.get(k)?.stay !== m) errors.push(`${k} stay ${byKey.get(k)?.stay} != ${m}`);
  for (const [k, m] of Object.entries(e.early ?? {})) if (byKey.get(k)?.early !== m) errors.push(`${k} early ${byKey.get(k)?.early} != ${m}`);
  for (const [k, m] of Object.entries(e.flexUsed ?? {})) if (byKey.get(k)?.flex_used !== m) errors.push(`${k} flex ${byKey.get(k)?.flex_used} != ${m}`);
  if ('conflict' in e) {
    const want = e.conflict ? JSON.stringify({ key: e.conflict.key, late_by: e.conflict.lateBy }) : 'null';
    if (JSON.stringify(out.conflict) !== want) errors.push(`conflict ${JSON.stringify(out.conflict)} != ${want}`);
  }
  if ('needsReturnHour' in e && out.needs_return_hour !== e.needsReturnHour) errors.push(`needs_return_hour ${out.needs_return_hour}`);
  if (errors.length) { console.error(`FAIL ${c.name}\n  ${errors.join('\n  ')}`); failed++; }
  else console.log(`PASS ${c.name}`);
}
if (failed) { console.error(`${failed} stop-schedule parity case(s) failed`); process.exit(1); }
console.log(`stop-schedule parity: ${fixture.cases.length} cases pass`);
