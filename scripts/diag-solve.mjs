#!/usr/bin/env node
// Diagnostic tool for the MAJOR BUG investigation (docs/UX_FLOWS.md §19):
// "clicking Solve and Autofill STILL sometimes makes certain rides
// disappear." Snapshots every rides/ride_requests/requests row for a
// department+week and diffs two snapshots taken before/after a UI action
// (Solve, Apply, auto-solve remaining, a manual board edit, …) — service
// role, local stack only (same connection-discovery/guard as
// scripts/fake-week.mjs). Never touches ../commucar-share; read-only against
// the DB (a plain `select`, no writes).
//
// Usage:
//   node scripts/diag-solve.mjs snapshot <name> [--dept נבו|nevo] [--week YYYY-MM-DD]
//   node scripts/diag-solve.mjs diff <nameA> <nameB>
//
// Typical repro session (sequence (a) of the investigation — reproduces the
// "disappears on a second Solve/Apply with no changes" bug):
//   node scripts/diag-solve.mjs snapshot before-first-apply
//   # ... Solve -> Apply in the UI ...
//   node scripts/diag-solve.mjs snapshot after-first-apply
//   # ... Solve -> Apply again, with nothing new to place ...
//   node scripts/diag-solve.mjs snapshot after-second-apply
//   node scripts/diag-solve.mjs diff after-first-apply after-second-apply
//
// Snapshots are written to scripts/.diag-solve/<name>.json (gitignored —
// this directory is not tracked; add scripts/.diag-solve/ to .gitignore if
// it is not already covered by a broader pattern).

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = path.join(__dirname, ".diag-solve");

const FALLBACK_ENV = {
  API_URL: "http://127.0.0.1:54321",
  SERVICE_ROLE_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU",
};

function readSupabaseStatusEnv() {
  try {
    const out = execSync("npx supabase status -o env", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const env = {};
    for (const line of out.split("\n")) {
      const m = /^([A-Z0-9_]+)="(.*)"$/.exec(line.trim());
      if (m) env[m[1]] = m[2];
    }
    return env;
  } catch {
    return {};
  }
}

function resolveConnection() {
  const statusEnv = readSupabaseStatusEnv();
  const url = process.env.VITE_SUPABASE_URL || statusEnv.API_URL || FALLBACK_ENV.API_URL;
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || statusEnv.SERVICE_ROLE_KEY || FALLBACK_ENV.SERVICE_ROLE_KEY;
  const hostname = new URL(url).hostname;
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
  if (!isLocal) {
    throw new Error(`diag-solve: refusing to run against a non-local URL (${url}) — this script is local-stack only`);
  }
  return { url, serviceRoleKey };
}

function parseArgs(argv) {
  const out = { dept: "נבו", week: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dept") out.dept = argv[++i];
    else if (argv[i] === "--week") out.week = argv[++i];
  }
  return out;
}

async function resolveDepartment(admin, deptSlugOrName) {
  const { data, error } = await admin
    .from("departments")
    .select("id, name, slug")
    .or(`slug.eq.${deptSlugOrName},name.eq.${deptSlugOrName}`)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`diag-solve: no department matching "${deptSlugOrName}"`);
  return data;
}

async function resolveWeek(admin, departmentId, weekArg) {
  if (weekArg) return weekArg;
  const { data, error } = await admin
    .from("weeks")
    .select("week_start, phase")
    .eq("department_id", departmentId)
    .order("week_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("diag-solve: no week found for this department; pass --week YYYY-MM-DD");
  return data.week_start;
}

/** Every rides + ride_requests + request-status row for one department/week, sorted for a stable diff. */
async function takeSnapshot(admin, departmentId, weekStart) {
  const [{ data: rides, error: ridesErr }, { data: requests, error: reqErr }, { data: rideRequests, error: rrErr }] =
    await Promise.all([
      admin
        .from("rides")
        .select("id, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, is_pinned, pin_reason, version")
        .eq("department_id", departmentId)
        .eq("week_start", weekStart)
        .order("id"),
      admin
        .from("requests")
        .select("id, requester_id, status, status_reason, version")
        .eq("department_id", departmentId)
        .eq("week_start", weekStart)
        .order("id"),
      admin
        .from("ride_requests")
        .select("ride_id, request_id, role, leg, car_mode")
        .order("ride_id")
        .order("request_id"),
    ]);
  if (ridesErr) throw ridesErr;
  if (reqErr) throw reqErr;
  if (rrErr) throw rrErr;

  const rideIds = new Set((rides ?? []).map((r) => r.id));
  return {
    departmentId,
    weekStart,
    takenAt: new Date().toISOString(),
    rides: rides ?? [],
    requests: requests ?? [],
    // Only ride_requests rows for this week's own rides (the table has no department/week columns of its own).
    rideRequests: (rideRequests ?? []).filter((rr) => rideIds.has(rr.ride_id)),
  };
}

function diffSnapshots(a, b) {
  const ridesA = new Map(a.rides.map((r) => [r.id, r]));
  const ridesB = new Map(b.rides.map((r) => [r.id, r]));

  const disappearedRides = [...ridesA.keys()].filter((id) => !ridesB.has(id));
  const newRides = [...ridesB.keys()].filter((id) => !ridesA.has(id));
  const changedRides = [...ridesA.keys()]
    .filter((id) => ridesB.has(id))
    .filter((id) => JSON.stringify(ridesA.get(id)) !== JSON.stringify(ridesB.get(id)))
    .map((id) => ({ id, before: ridesA.get(id), after: ridesB.get(id) }));

  const statusA = new Map(a.requests.map((r) => [r.id, r.status]));
  const statusB = new Map(b.requests.map((r) => [r.id, r.status]));
  const regressedRequests = [...statusA.keys()]
    .filter((id) => statusB.has(id))
    .filter((id) => {
      const before = statusA.get(id);
      const after = statusB.get(id);
      // A request "regressing" is what the owner sees as a ride disappearing:
      // it had a placement (assigned/merged) and now has none, with no ride
      // to show for it — the exact MAJOR BUG shape.
      return (before === "assigned" || before === "merged") && (after === "waitlisted" || after === "submitted");
    })
    .map((id) => ({ id, before: statusA.get(id), after: statusB.get(id) }));

  return { disappearedRides, newRides, changedRides, regressedRequests };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "snapshot") {
    const [name, ...flagArgv] = rest;
    if (!name) throw new Error("usage: node scripts/diag-solve.mjs snapshot <name> [--dept ...] [--week ...]");
    const args = parseArgs(flagArgv);
    const { url, serviceRoleKey } = resolveConnection();
    const admin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const dept = await resolveDepartment(admin, args.dept);
    const weekStart = await resolveWeek(admin, dept.id, args.week);
    const snapshot = await takeSnapshot(admin, dept.id, weekStart);
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const file = path.join(SNAPSHOT_DIR, `${name}.json`);
    writeFileSync(file, JSON.stringify(snapshot, null, 2));
    console.log(
      `diag-solve: snapshot "${name}" saved (${snapshot.rides.length} rides, ${snapshot.requests.length} requests) -> ${file}`,
    );
    return;
  }

  if (command === "diff") {
    const [nameA, nameB] = rest;
    if (!nameA || !nameB) throw new Error("usage: node scripts/diag-solve.mjs diff <nameA> <nameB>");
    const fileA = path.join(SNAPSHOT_DIR, `${nameA}.json`);
    const fileB = path.join(SNAPSHOT_DIR, `${nameB}.json`);
    if (!existsSync(fileA)) throw new Error(`diag-solve: no snapshot "${nameA}" (looked in ${fileA})`);
    if (!existsSync(fileB)) throw new Error(`diag-solve: no snapshot "${nameB}" (looked in ${fileB})`);
    const a = JSON.parse(readFileSync(fileA, "utf8"));
    const b = JSON.parse(readFileSync(fileB, "utf8"));
    const diff = diffSnapshots(a, b);

    console.log(`diag-solve: diff "${nameA}" (${a.takenAt}) -> "${nameB}" (${b.takenAt})`);
    console.log(`  rides that disappeared: ${diff.disappearedRides.length}`, diff.disappearedRides);
    console.log(`  rides that are new: ${diff.newRides.length}`, diff.newRides);
    console.log(`  rides that changed: ${diff.changedRides.length}`);
    for (const c of diff.changedRides) console.log("   ", JSON.stringify(c));
    console.log(`  requests that regressed (assigned/merged -> waitlisted/submitted, no ride): ${diff.regressedRequests.length}`);
    for (const r of diff.regressedRequests) console.log("   ", JSON.stringify(r));

    if (diff.disappearedRides.length > 0 || diff.regressedRequests.length > 0) {
      console.log("\ndiag-solve: THE BUG REPRODUCED — rides disappeared and/or requests regressed with no ride.");
      process.exitCode = 1;
    } else {
      console.log("\ndiag-solve: no disappearance/regression between these two snapshots.");
    }
    return;
  }

  throw new Error("usage: node scripts/diag-solve.mjs <snapshot|diff> ...");
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exitCode = 1;
});
