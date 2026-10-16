#!/usr/bin/env node
// scripts/replay/compare.mjs — how closely the local re-run matches production.
//
//   node scripts/replay/compare.mjs --export <file> [--run first|last|<solver_run id>] [--against replay|final] [--json <out.json>]
//
// Left side: the target week's rides as they were right after that production solver run was
// applied (rebuilt from audit_log, like `load-week.mjs --at after-first-run`). Right side:
//   --against replay (default)  the replay stack now (after `qa:sadran -- autofill`) — solver parity
//   --against final             production as exported — what the Sadran changed after the solver
// Lines the two up per request: car and time, placed on one side only, unmet on both. Read-only.
import { writeFileSync } from "node:fs";
import path from "node:path";

import { psql } from "./lib.mjs";
import { rowsAt, readExport } from "./load-week.mjs";

function parseArgs(argv) {
  const out = { run: "first", against: "replay" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--export") out.export = argv[++i];
    else if (argv[i] === "--run") out.run = argv[++i];
    else if (argv[i] === "--json") out.json = argv[++i];
    else if (argv[i] === "--against") out.against = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!out.export) throw new Error("usage: compare.mjs --export <file> [--run first|last|<id>] [--against replay|final] [--json <file>]");
  if (!["replay", "final"].includes(out.against)) throw new Error("--against must be replay or final");
  return out;
}

const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hour12: false });
const span = (ride) => `${clock.format(new Date(ride.starts_at))}-${hm.format(new Date(ride.ends_at))}`;

/** request id -> [{ car, window, leg, role }] for every live ride serving it. */
function placements(rides, rideRequests, carName) {
  const live = new Map(rides.filter((r) => r.status !== "cancelled").map((r) => [r.id, r]));
  const out = new Map();
  for (const link of rideRequests) {
    const ride = live.get(link.ride_id);
    if (!ride) continue;
    const list = out.get(link.request_id) ?? [];
    list.push({ car: carName(ride.car_id), window: span(ride), leg: link.leg, role: link.role, driverless: !ride.driver_id });
    out.set(link.request_id, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.leg.localeCompare(b.leg) || a.window.localeCompare(b.window));
  return out;
}

const describe = (list) => (list ?? []).map((p) => `${p.car} ${p.window}${p.leg === "both" ? "" : ` (${p.leg})`}${p.role === "passenger" ? " passenger" : ""}${p.driverless ? " NO DRIVER" : ""}`).join(" + ");

function main() {
  const args = parseArgs(process.argv.slice(2));
  const t = readExport(path.resolve(args.export));
  const dept = t.departments[0].id;
  const runs = t.solver_runs.filter((r) => r.applied).sort((a, b) => a.started_at.localeCompare(b.started_at));
  const run = args.run === "first" ? runs[0] : args.run === "last" ? runs[runs.length - 1] : runs.find((r) => r.id === args.run);
  if (!run) throw new Error(`no applied solver run "${args.run}" in the export`);
  const week = run.week_start;

  // Production: the week right after `run` was applied.
  // Inserts only: later edits of those rides keep the run id and must not move the cut. The whole
  // apply is one transaction, so its rows share one audit timestamp; one second after it is safe.
  const writes = t.audit_log.filter((e) => e.table_name === "rides" && e.action === "insert" && e.after?.created_by_solver_run_id === run.id);
  const cutMs = (writes.length ? Math.max(...writes.map((e) => Date.parse(e.at))) : Date.parse(run.finished_at)) + 1000;
  // The audit log also holds the week before the target; keep the target week only.
  const inWeek = (rows) => rows.filter((r) => r.week_start === week);
  const prodRides = inWeek(rowsAt("rides", inWeek(t.rides), t.audit_log, cutMs));
  const prodRideIds = new Set(prodRides.map((r) => r.id));
  const prodLinks = rowsAt("ride_requests", t.ride_requests, t.audit_log, cutMs).filter((l) => prodRideIds.has(l.ride_id));
  const prodRequests = inWeek(rowsAt("requests", inWeek(t.requests), t.audit_log, cutMs));

  // Right side: the replay stack now, or production as exported.
  const local = args.against === "final" ? {
    rides: inWeek(t.rides),
    links: t.ride_requests.filter((l) => inWeek(t.rides).some((r) => r.id === l.ride_id)),
    requests: inWeek(t.requests).map((r) => ({ id: r.id, status: r.status })),
    cars: [],
  } : JSON.parse(psql(`select json_build_object(
      'rides', coalesce((select json_agg(x) from public.rides x where x.department_id = '${dept}' and x.week_start = '${week}'), '[]'),
      'links', coalesce((select json_agg(l) from public.ride_requests l join public.rides x on x.id = l.ride_id where x.department_id = '${dept}' and x.week_start = '${week}'), '[]'),
      'requests', coalesce((select json_agg(json_build_object('id', r.id, 'status', r.status)) from public.requests r where r.department_id = '${dept}' and r.week_start = '${week}'), '[]'),
      'cars', coalesce((select json_agg(json_build_object('id', c.id, 'name', c.name)) from public.cars c where c.department_id = '${dept}'), '[]'));`));

  const cars = new Map([...t.cars, ...local.cars].map((c) => [c.id, c.name]));
  const carName = (id) => cars.get(id) ?? id.slice(0, 8);
  const people = new Map(t.profiles.map((p) => [p.id, p.display_name ?? p.full_name ?? p.id.slice(0, 8)]));
  const prod = placements(prodRides, prodLinks, carName);
  const mine = placements(local.rides, local.links, carName);
  const localStatus = new Map(local.requests.map((r) => [r.id, r.status]));

  // Requests filed after the run exist only on the right side; list them too.
  const allRequests = [...prodRequests, ...(args.against === "final" ? inWeek(t.requests).filter((r) => !prodRequests.some((p) => p.id === r.id)) : [])];
  const rows = [];
  for (const r of [...allRequests].sort((a, b) => String(a.depart_at ?? a.return_at).localeCompare(String(b.depart_at ?? b.return_at)))) {
    if (["withdrawn", "cancelled", "draft"].includes(r.status) && ["withdrawn", "cancelled", "draft", undefined].includes(localStatus.get(r.id))) continue;
    const a = describe(prod.get(r.id));
    const b = describe(mine.get(r.id));
    const right = args.against === "final" ? "final" : "replay";
    const kind = !a && !b ? "unmet-both" : !a ? `${right}-only` : !b ? "run-only" : a === b ? "same" : prod.get(r.id).map((p) => p.car).join() === mine.get(r.id).map((p) => p.car).join() ? "same-car-other-time" : "other-car";
    rows.push({ request: r.id, who: people.get(r.requester_id) ?? "?", when: clock.format(new Date(r.depart_at ?? r.return_at)), kind, production: a || `unmet (${r.status})`, local: b || `unmet (${localStatus.get(r.id) ?? "?"})`, status: localStatus.get(r.id) });
  }

  const tally = rows.reduce((acc, row) => ({ ...acc, [row.kind]: (acc[row.kind] ?? 0) + 1 }), {});
  const rightLabel = args.against === "final" ? "production as exported (after the Sadran's changes)" : "the replay stack now";
  console.log(`week ${week}, production run ${run.id} (${run.started_at}) vs ${rightLabel}`);
  console.log(`  ${Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join("  ")}`);
  for (const row of rows.filter((x) => x.kind !== "same" && x.kind !== "unmet-both")) {
    console.log(`  [${row.kind}] ${row.when} ${row.who} (${row.request.slice(0, 8)})\n      solver run: ${row.production}\n      ${args.against === "final" ? "final:     " : "replay:    "} ${row.local}`);
  }
  if (args.json) writeFileSync(path.resolve(args.json), JSON.stringify({ week, run: run.id, tally, rows }, null, 2));
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
