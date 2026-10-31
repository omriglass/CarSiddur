#!/usr/bin/env node
// scripts/replay/export-from-debug.mjs — the week export for replays, taken from the local debug copy of production
// (`npm run debug`, scripts/debug/README.md) instead of the Supabase dashboard: the same read-only
// `export-week.sql`, with its `params` filled in, run against the debug stack's database. Writes the JSON file
// `replay:load` reads (one row per table: table_name, row_count, rows).
//
//   npm run debug -- pull && npm run debug -- load --all      # once per review: a fresh copy, every week
//   npm run replay:export -- --dept <department id> --week <YYYY-MM-DD, the Sunday> [--out .replay/data/<file>.json]
//
// Only reads; only from the debug stack's container (never production, never the owner's stack).
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ROOT } from "./lib.mjs";

const DEBUG_DB_CONTAINER = "supabase_db_carshare-debug";

function fail(message) {
  console.error(`replay:export: ${message}`);
  process.exit(1);
}

const args = { dept: null, week: null, out: null };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--dept") args.dept = argv[++i];
  else if (argv[i] === "--week") args.week = argv[++i];
  else if (argv[i] === "--out") args.out = argv[++i];
  else fail(`unknown argument ${argv[i]}`);
}
if (!/^[0-9a-f-]{36}$/i.test(args.dept ?? "")) fail("--dept <department uuid> is required");
if (!/^\d{4}-\d{2}-\d{2}$/.test(args.week ?? "")) fail("--week <YYYY-MM-DD> (the Sunday) is required");

function psql(sql) {
  const res = spawnSync("docker", ["exec", "-i", DEBUG_DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-X", "-q", "-At"],
    { input: sql, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (res.status !== 0) fail(`psql on ${DEBUG_DB_CONTAINER} failed (is the debug copy loaded? npm run debug -- load --all):\n${(res.stderr || res.stdout).slice(-2000)}`);
  return res.stdout;
}

// The export reads 5 weeks back (fairness, mileage) and 2 ahead (series legs): the debug copy must hold them.
const have = psql(`select count(*) from public.weeks where department_id = '${args.dept}' and week_start between date '${args.week}' - 35 and date '${args.week}'`).trim();
if (Number(have) === 0) fail(`the debug copy has no weeks of ${args.dept} up to ${args.week} — load every week: npm run debug -- load --all`);

const template = readFileSync(path.join(ROOT, "scripts/replay/export-week.sql"), "utf8");
const filled = template.replace(
  /with params as \(\s*select\s*'[^']*'::uuid as dept,\s*date '[^']*' as week\s*\)/,
  `with params as (\n  select\n    '${args.dept}'::uuid as dept,\n    date '${args.week}' as week\n)`,
);
if (filled === template) fail("could not find the params block in export-week.sql");
const json = psql(`select coalesce(json_agg(x), '[]') from (\n${filled.replace(/;\s*$/, "")}\n) x;`).trim();
const rows = JSON.parse(json);
const out = path.resolve(args.out ?? path.join(ROOT, ".replay", "data", `${args.dept}-${args.week}.json`));
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(rows));
console.log(`replay:export: ${rows.length} tables, ${rows.reduce((n, r) => n + Number(r.row_count), 0)} rows → ${path.relative(ROOT, out)}`);
console.log(`next: npm run replay:stack -- start && npm run replay:load -- --export ${path.relative(ROOT, out)}`);
