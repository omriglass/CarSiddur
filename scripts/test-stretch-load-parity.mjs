// scripts/test-stretch-load-parity.mjs
//
// REQ item 246 h (LT1 phase 2a): runs the shared seats-per-stretch cases in
// supabase/tests/fixtures/stretch_load_cases.json against the SQL half of the
// rule, public._stretch_loads(), in the configured local database container.
// The TS half of the same cases is src/solver/__tests__/stretchLoads.test.ts.
// Read-only (one SELECT per case). Called at the end of db:test.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const config = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');
const projectId = /^project_id\s*=\s*"([^"]+)"/m.exec(config)?.[1];
if (!projectId) throw new Error('Missing Supabase project_id');
const container = process.env.SUPABASE_DB_CONTAINER ?? `supabase_db_${projectId}`;

const fixture = JSON.parse(
  readFileSync(new URL('../supabase/tests/fixtures/stretch_load_cases.json', import.meta.url), 'utf8'),
);

let failed = 0;
for (const c of fixture.cases) {
  const sql = `select public._stretch_loads(${c.points}, '${JSON.stringify(c.riders).replace(/'/g, "''")}'::jsonb)`;
  const res = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (res.status !== 0) { console.error(`FAIL ${c.name}\n${res.stderr}`); failed++; continue; }
  const got = JSON.parse(res.stdout.trim()).map((l) => [l.adults, l.childSeats, l.boosters]);
  if (JSON.stringify(got) !== JSON.stringify(c.loads)) {
    console.error(`FAIL ${c.name}\n  got ${JSON.stringify(got)}, want ${JSON.stringify(c.loads)}`);
    failed++;
  } else console.log(`PASS ${c.name}`);
}
if (failed) { console.error(`${failed} stretch-load parity case(s) failed`); process.exit(1); }
console.log(`stretch-load parity: ${fixture.cases.length} cases pass`);
