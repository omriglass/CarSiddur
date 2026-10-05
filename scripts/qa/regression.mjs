#!/usr/bin/env node
// QA regression (docs/QA_SIMULATION.md section 5): fixed seed -> generate the QA week on a disposable
// stack -> solve the whole week with the REAL solver (via the TS bridge, vite-node) -> apply_solver_result as
// the QA Sadran -> invariant checks. Exits non-zero on any violation, printing the list.
//
//   npm run qa:regression [-- --seed 7 --out <dir> --api <url>]
//   QA_REGRESSION=1 npm run db:test          (opt-in tail of the SQL runner)
//
// Environment: SUPABASE_DB_CONTAINER (the stack's DB container; defaults to the disposable stack's when the
// API is on :57321), QA_API_URL, QA_REGRESSION_IGNORE=CODE,CODE (downgrade known findings to warnings).
// Never runs against the owner's stack (port 54321) - CI is the only exception (qa-common.mjs).

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateWeek } from "./generate-week.mjs";
import { LOCAL_ANON_KEY, parseArgs, resolveApi, signedInClient } from "./qa-common.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");
const DISPOSABLE_CONTAINER = "supabase_db_carshare-origins-test";

function dbContainer(api) {
  if (process.env.SUPABASE_DB_CONTAINER) return process.env.SUPABASE_DB_CONTAINER;
  if (new URL(api.url).port === "57321") return DISPOSABLE_CONTAINER;
  throw new Error("qa-regression: set SUPABASE_DB_CONTAINER for a stack other than the disposable one on :57321");
}

function runInvariantSql(container, world) {
  const sql = readFileSync(path.join(here, "invariants.sql"));
  const out = execFileSync(
    "docker",
    ["exec", "-i", container, "psql", "-q", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-v", `dept=${world.department.id}`, "-v", `week=${world.weekStart}`, "-f", "-"],
    { input: sql, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const violations = [];
  const stats = {};
  for (const line of out.split("\n")) {
    const [kind, a, b] = line.split("|");
    if (kind === "VIOLATION") violations.push({ code: a, detail: line.split("|").slice(2).join("|") });
    else if (kind === "STAT") stats[a] = Number(b);
  }
  return { violations, stats };
}

function runSolve(api, worldPath, solveOut) {
  const res = spawnSync("npx", ["vite-node", "-c", "scripts/qa/vite.config.ts", "scripts/qa/solve-week.ts"], {
    cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      VITE_SUPABASE_URL: api.url, VITE_SUPABASE_ANON_KEY: LOCAL_ANON_KEY, VITE_VAPID_PUBLIC_KEY: "qa-placeholder", VITE_APP_URL: "http://localhost:8092",
      QA_WORLD: worldPath, QA_SOLVE_OUT: solveOut,
    },
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr.split("\n").filter((l) => !l.startsWith("    at ")).join("\n"));
  return res.status;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { seed: "7", out: "", api: "" });
  const api = resolveApi(args.api);
  const container = dbContainer(api);
  const out = args.out ? path.resolve(args.out) : mkdtempSync(path.join(os.tmpdir(), "qa-regression-"));
  const ignore = new Set((process.env.QA_REGRESSION_IGNORE ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const tag = `reg${Date.now().toString(36)}`;

  console.log(`qa-regression: seed ${args.seed}, api ${api.url}, container ${container}, out ${out}`);
  const gen = await generateWeek({ seed: Number(args.seed), out, apiUrl: api.url, tag, log: (m) => console.log(`  gen: ${m}`) });
  const violations = [];
  if (gen.failureRate > 0.1) violations.push({ code: "GENERATOR_FAILURES", detail: `${gen.failures.length} requests failed to file: ${gen.failures.slice(0, 3).map((f) => f.error).join("; ")}` });

  const worldPath = path.join(out, "world.json");
  const solvePath = path.join(out, "solve.json");
  const solveStatus = runSolve(api, worldPath, solvePath);
  let solve = null;
  try { solve = JSON.parse(readFileSync(solvePath, "utf8")); } catch { /* solve crashed before writing */ }
  if (!solve) violations.push({ code: "SOLVE_FAILED", detail: `solve-week exited ${solveStatus} without a result` });
  else {
    if (solve.solverCrash) violations.push({ code: "SOLVER_CRASH", detail: solve.solverCrash });
    if (solve.applyError) violations.push({ code: "APPLY_FAILED", detail: solve.applyError });
    for (const u of solve.unmet) if (!u.reasonCode) violations.push({ code: "UNMET_WITHOUT_REASON_CODE", detail: `request ${u.requestId}` });
  }

  const sql = runInvariantSql(container, gen.world);
  violations.push(...sql.violations);

  // Publication readiness as the QA Sadran: no conflicting rides on any day.
  const sadran = await signedInClient(api, gen.world.sadran.email, gen.world.sadran.password);
  const readiness = await sadran.rpc("publication_readiness", { p_department_id: gen.world.department.id, p_week_start: gen.world.weekStart });
  if (readiness.error) violations.push({ code: "READINESS_FAILED", detail: readiness.error.message });
  else for (const day of readiness.data) if (day.conflictRides > 0) violations.push({ code: "PUBLICATION_CONFLICT", detail: `${day.day}: ${day.conflictRides} conflicting ride(s)` });

  const byReason = {};
  for (const u of solve?.unmet ?? []) byReason[u.reasonCode] = (byReason[u.reasonCode] ?? 0) + 1;
  const hard = violations.filter((v) => !ignore.has(v.code));
  const report = { seed: Number(args.seed), week: gen.world.weekStart, requests: gen.submittedCount, stats: solve?.stats ?? null, unmetByReason: byReason, dbStats: sql.stats, readiness: readiness.data ?? null, violations };
  writeFileSync(path.join(out, "regression-report.json"), `${JSON.stringify(report, null, 2)}\n`);

  console.log(`\nqa-regression: ${gen.submittedCount} requests, ${solve?.stats?.served ?? "?"} served, ${solve?.stats?.unmet ?? "?"} unmet, ${sql.stats.rides ?? "?"} rides`);
  console.log("unmet by reason:");
  for (const [code, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) console.log(`  ${code.padEnd(32)} ${n}`);
  if (violations.length) {
    console.log(`\n${hard.length} violation(s)${violations.length > hard.length ? `, ${violations.length - hard.length} ignored (QA_REGRESSION_IGNORE)` : ""}:`);
    for (const v of violations) console.log(`  ${ignore.has(v.code) ? "(ignored) " : ""}${v.code}: ${v.detail}`);
  }
  if (hard.length) { console.error("\nqa-regression: FAILED"); process.exit(1); }
  console.log("\nqa-regression: OK");
}

main().catch((e) => { console.error(`qa-regression: ${e.message}`); process.exit(1); });
