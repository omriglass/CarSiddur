#!/usr/bin/env node
// scripts/replay/load-week.mjs — loads a production week exported by
// scripts/replay/export-week.sql into the replay stack (scripts/replay/stack.mjs),
// so the real solver can be re-run on it locally (`npm run qa:sadran -- autofill`).
//
//   node scripts/replay/load-week.mjs --export <file.json|file.csv> [--at <point>] [--week YYYY-MM-DD]
//
// --at decides which moment of the target week is rebuilt (rows of other weeks are always
// loaded as they are now — they are history the solver only reads):
//   before-first-run  (default) the week as the first applied solver run saw it
//   before-last-run   the week as the last applied solver run saw it
//   after-first-run   right after the first run was applied (the production solver's output)
//   now               exactly as exported (incl. every manual edit)
//   <ISO timestamp>   any other moment
// The target week's requests, rides, ride links, passengers, proposals, waiting-list groups and
// week row are rebuilt from audit_log (before/after of every change). Stops, children,
// companions and plan B rows are not audited and are loaded as they are now.
//
// Writes ONLY to the replay stack's database container (refuses any other). Inside one
// transaction with session_replication_role = replica, so rows land exactly as exported:
// no triggers (no audit, no notifications, no version bumps) and no FK checks. Every loaded
// member gets a local email/password login (printed, and stored in <out>/world.json for the
// QA Sadran CLI). pg_cron is paused on the replay stack so the week never moves on its own.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPLAY_API, ROOT, psql } from "./lib.mjs";

export const REPLAY_PASSWORD = "replay-local-1234";

// --- arguments -----------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { at: "before-first-run" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--export") out.export = argv[++i];
    else if (a === "--at") out.at = argv[++i];
    else if (a === "--week") out.week = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.export) throw new Error("usage: load-week.mjs --export <file.json|file.csv> [--at <point>] [--week YYYY-MM-DD] [--out <dir>]");
  return out;
}

// --- export parsing ------------------------------------------------------------------------

/** Minimal RFC 4180 CSV reader (quoted fields, doubled quotes, newlines inside quotes). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f !== ""));
}

/** { table_name: rows[] } from the SQL editor's JSON or CSV download. */
export function readExport(file) {
  const text = readFileSync(file, "utf8").replace(/^﻿/, "");
  let records;
  if (/^\s*\[/.test(text)) {
    records = JSON.parse(text);
  } else {
    const [header, ...body] = parseCsv(text);
    records = body.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i]])));
  }
  const tables = {};
  for (const rec of records) {
    const rows = typeof rec.rows === "string" ? JSON.parse(rec.rows) : rec.rows;
    if (!Array.isArray(rows)) throw new Error(`export: table ${rec.table_name} has no rows array`);
    if (rec.row_count !== undefined && Number(rec.row_count) !== rows.length) {
      throw new Error(`export: ${rec.table_name} says ${rec.row_count} rows but holds ${rows.length} — the download was cut`);
    }
    tables[rec.table_name] = rows;
  }
  for (const t of ["departments", "requests", "audit_log", "solver_runs"]) {
    if (!tables[t]) throw new Error(`export: missing table ${t}`);
  }
  return tables;
}

// --- rebuilding the target week from audit_log -------------------------------------------

/** audit_log.row_id of a live row (mirrors audit_row()'s key). */
function auditKey(table, row) {
  if (table === "ride_requests") return `${row.ride_id}|${row.request_id}|${row.leg ?? ""}`;
  if (table === "weeks") return `${row.department_id}|${row.week_start}`;
  return row.id;
}

export const AUDITED_WEEK_TABLES = ["requests", "rides", "ride_requests", "ride_passengers", "proposals", "proposal_parties", "waitlist_groups", "waitlist_group_members", "weeks"];

export function cutPoint(at, solverRuns, audit) {
  const applied = solverRuns.filter((r) => r.applied).sort((a, b) => a.started_at.localeCompare(b.started_at));
  if (at === "now") return null;
  if (at === "before-first-run" || at === "before-last-run") {
    const run = at === "before-first-run" ? applied[0] : applied[applied.length - 1];
    if (!run) throw new Error(`--at ${at}: the export holds no applied solver run`);
    return { ms: Date.parse(run.started_at), label: `${at} (${run.id}, ${run.started_at})` };
  }
  if (at === "after-first-run") {
    const run = applied[0];
    if (!run) throw new Error("--at after-first-run: the export holds no applied solver run");
    // Inserts only: later edits of those rides keep the run id and must not move the cut.
    const writes = audit.filter((e) => e.table_name === "rides" && e.action === "insert" && e.after?.created_by_solver_run_id === run.id);
    if (!writes.length) throw new Error(`--at after-first-run: no ride in the audit log was created by run ${run.id}`);
    const last = Math.max(...writes.map((e) => Date.parse(e.at)));
    return { ms: last + 1000, label: `after-first-run (${run.id}, rides written until ${new Date(last).toISOString()})` };
  }
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) throw new Error(`--at: not a known point or an ISO timestamp: ${at}`);
  return { ms, label: at };
}

/**
 * Rows of `table` in the target week as they were at `cutMs`: the last audited state at or
 * before it, else the state just before the first change after it (absent if that change
 * was the insert); rows with no audited change keep their current state.
 */
export function rowsAt(table, currentRows, audit, cutMs) {
  const entries = new Map();
  for (const e of audit) {
    if (e.table_name !== table) continue;
    const list = entries.get(e.row_id) ?? [];
    list.push(e);
    entries.set(e.row_id, list);
  }
  const out = [];
  const seen = new Set();
  for (const row of currentRows) {
    const key = auditKey(table, row);
    seen.add(key);
    const state = stateAt(entries.get(key), cutMs, row);
    if (state) out.push(state);
  }
  for (const [key, list] of entries) {
    if (seen.has(key)) continue;
    const state = stateAt(list, cutMs, null);
    if (state) out.push(state);
  }
  return out;
}

function stateAt(list, cutMs, current) {
  if (!list || !list.length) return current;
  const sorted = [...list].sort((a, b) => Number(a.id) - Number(b.id));
  const before = sorted.filter((e) => Date.parse(e.at) <= cutMs);
  const last = before[before.length - 1];
  if (last) return last.action === "delete" ? null : last.after;
  const first = sorted[0];
  return first.action === "insert" ? null : first.before;
}

// --- SQL generation --------------------------------------------------------------------------

function dollar(text) {
  let tag = "j";
  while (text.includes(`$${tag}$`)) tag += "x";
  return `$${tag}$${text}$${tag}$`;
}

const quoteIdent = (name) => `"${name.replace(/"/g, '""')}"`;
const quoteLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** Table name -> insertable columns (not generated) on the replay database. */
function insertableColumns(tables) {
  const list = tables.map(quoteLiteral).join(",");
  const out = psql(`select table_name, string_agg(column_name, ',' order by ordinal_position)
    from information_schema.columns
    where table_schema = 'public' and table_name in (${list}) and is_generated = 'NEVER'
    group by table_name;`);
  const map = {};
  for (const line of out.trim().split("\n").filter(Boolean)) {
    const [name, cols] = line.split("|");
    map[name] = new Set(cols.split(","));
  }
  return map;
}

/** One insert per group of rows that carry the same keys, so a key a row lacks gets the column default. */
function insertSql(table, rows, columns) {
  if (!rows.length) return "";
  if (!columns) throw new Error(`replay database has no table public.${table}`);
  const groups = new Map();
  for (const row of rows) {
    const keys = Object.keys(row).filter((k) => columns.has(k)).sort();
    const sig = keys.join(",");
    const group = groups.get(sig) ?? { keys, rows: [] };
    group.rows.push(row);
    groups.set(sig, group);
  }
  let sql = "";
  for (const { keys, rows: groupRows } of groups.values()) {
    const cols = keys.map(quoteIdent).join(", ");
    sql += `insert into public.${table} (${cols}) overriding system value select ${cols} from jsonb_populate_recordset(null::public.${table}, ${dollar(JSON.stringify(groupRows))}::jsonb);\n`;
  }
  return sql;
}

const idList = (rows, key = "id") => {
  const ids = [...new Set(rows.map((r) => r[key]).filter(Boolean))];
  return ids.length ? ids.map(quoteLiteral).join(",") : "null";
};

/** Remove whatever an earlier load of this department left (FK cascades do not run in replica mode). */
function deleteSql(dept, t) {
  const d = quoteLiteral(dept);
  return `
delete from public.request_children where request_id in (select id from public.requests where department_id = ${d}) or request_id in (${idList(t.requests)});
delete from public.request_companions where request_id in (select id from public.requests where department_id = ${d}) or request_id in (${idList(t.requests)});
delete from public.ride_requests where ride_id in (select id from public.rides where department_id = ${d}) or ride_id in (${idList(t.rides)});
delete from public.proposal_parties where proposal_id in (select id from public.proposals where department_id = ${d}) or proposal_id in (${idList(t.proposals)});
delete from public.child_guardians where child_id in (select id from public.children where department_id = ${d}) or child_id in (${idList(t.children)});
delete from public.car_seat_configs where car_id in (select id from public.cars where department_id = ${d}) or car_id in (${idList(t.cars)});
delete from public.policy_versions where policy_id in (select id from public.policies where department_id = ${d}) or id in (${idList(t.policy_versions)});
${["request_stops", "request_alternatives", "ride_passengers", "waitlist_group_members", "waitlist_groups", "proposals", "rides", "requests",
    "weeks", "week_stats", "sadran_assignments", "children", "car_maintenance_blocks", "policies", "place_distances", "department_members",
    "department_settings"].map((table) => `delete from public.${table} where department_id = ${d};`).join("\n")}
delete from public.cars where department_id = ${d} or id in (${idList(t.cars)});
delete from public.ride_types where department_id = ${d} or id in (${idList(t.ride_types)});
delete from public.destinations where department_id = ${d} or id in (${idList(t.destinations)});
delete from public.departments where id = ${d};
delete from auth.identities where user_id in (${idList(t.profiles)});
delete from public.profiles where id in (${idList(t.profiles)});
delete from auth.users where id in (${idList(t.profiles)});
`;
}

/**
 * Short local logins: the week's Sadran is sadran@replay.local, admins admin1@…, everyone else m1@…
 * (numbered by name, so the same export always gives the same logins).
 */
function replayEmails(profiles, sadranId) {
  const name = (p) => p.display_name ?? p.full_name ?? p.id;
  const sorted = [...profiles].sort((a, b) => name(a).localeCompare(name(b)) || a.id.localeCompare(b.id));
  const emails = new Map();
  let admins = 0;
  let members = 0;
  for (const p of sorted) {
    if (p.id === sadranId) emails.set(p.id, "sadran@replay.local");
    else if (p.is_admin) emails.set(p.id, `admin${++admins}@replay.local`);
    else emails.set(p.id, `m${++members}@replay.local`);
  }
  return emails;
}

/** A local email/password login per loaded profile (handle_new_user does not run in replica mode). */
function authUsersSql(profiles) {
  if (!profiles.length) return "";
  const users = profiles.map((p) => ({ id: p.id, email: p.email, name: p.display_name ?? p.full_name ?? "" }));
  return `
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
select '00000000-0000-0000-0000-000000000000', (u->>'id')::uuid, 'authenticated', 'authenticated', u->>'email',
  crypt(${quoteLiteral(REPLAY_PASSWORD)}, gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', u->>'name'), now(), now(), '', '', '', ''
from jsonb_array_elements(${dollar(JSON.stringify(users))}::jsonb) u;
insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), (u->>'id')::uuid, u->>'id', jsonb_build_object('sub', u->>'id', 'email', u->>'email'), 'email', now(), now(), now()
from jsonb_array_elements(${dollar(JSON.stringify(users))}::jsonb) u;
`;
}

// Parents before children only matters for readability: FK checks are off in replica mode.
const LOAD_ORDER = [
  "departments", "department_settings", "destinations", "place_distances", "ride_types", "profiles", "department_members",
  "sadran_assignments", "cars", "car_seat_configs", "car_maintenance_blocks", "policies", "policy_versions", "weeks",
  "children", "child_guardians", "requests", "request_stops", "request_children", "request_companions", "request_alternatives",
  "rides", "ride_requests", "ride_passengers", "proposals", "proposal_parties", "waitlist_groups", "waitlist_group_members", "week_stats",
];

// --- main ------------------------------------------------------------------------------------

function inferWeek(t, explicit) {
  if (explicit) return explicit;
  // solver_runs holds the target week only (audit_log also holds the week before it).
  const weeks = new Set(t.solver_runs.map((r) => r.week_start).filter(Boolean));
  if (weeks.size !== 1) throw new Error(`cannot tell the target week (${[...weeks].join(", ") || "none"}) — pass --week`);
  return [...weeks][0];
}

function describeRuns(runs) {
  return [...runs].sort((a, b) => a.started_at.localeCompare(b.started_at)).map((r) =>
    `  ${r.started_at}  ${r.applied ? "applied" : "not applied"}  ${r.status}  ${JSON.stringify(r.summary)}  (${r.id})`).join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const t = readExport(path.resolve(args.export));
  const dept = t.departments[0]?.id;
  if (!dept) throw new Error("export: no department row");
  const week = inferWeek(t, args.week);
  const cut = cutPoint(args.at, t.solver_runs, t.audit_log);

  const rebuilt = { ...t };
  if (cut) {
    // Every week the export carries history for (the target week and the one before it).
    const rebuiltWeeks = new Set(t.audit_log.map((e) => e.week_start).filter(Boolean));
    rebuiltWeeks.add(week);
    const auditedRideIds = new Set(t.audit_log.filter((e) => e.table_name === "rides").map((e) => e.row_id));
    const auditedProposalIds = new Set(t.audit_log.filter((e) => e.table_name === "proposals").map((e) => e.row_id));
    const rideWeek = new Map(t.rides.map((ride) => [ride.id, ride.week_start]));
    const proposalWeek = new Map((t.proposals ?? []).map((p) => [p.id, p.week_start]));
    for (const table of AUDITED_WEEK_TABLES) {
      const all = t[table] ?? [];
      const isWeekRow = (row) => (table === "ride_requests"
        ? rebuiltWeeks.has(rideWeek.get(row.ride_id)) || auditedRideIds.has(row.ride_id)
        : table === "proposal_parties"
          ? rebuiltWeeks.has(proposalWeek.get(row.proposal_id)) || auditedProposalIds.has(row.proposal_id)
          : rebuiltWeeks.has(row.week_start));
      const other = all.filter((row) => !isWeekRow(row));
      rebuilt[table] = [...other, ...rowsAt(table, all.filter(isWeekRow), t.audit_log, cut.ms)];
    }
    // Unaudited children of requests: only for requests that existed at the cut.
    const requestIds = new Set(rebuilt.requests.map((r) => r.id));
    for (const table of ["request_stops", "request_children", "request_companions", "request_alternatives"]) {
      rebuilt[table] = (t[table] ?? []).filter((row) => requestIds.has(row.request_id));
    }
  }

  // The QA Sadran CLI's world file: whoever was Sadran of the target week, else a department sadran/admin.
  const memberRole = new Map((t.department_members ?? []).filter((m) => !m.removed_at).map((m) => [m.profile_id, m.role]));
  const sadranId = (t.sadran_assignments ?? []).find((s) => s.week_start === week)?.profile_id
    ?? [...memberRole].find(([, role]) => role === "sadran" || role === "admin")?.[0];

  // The export leaves contact data out; profiles.email is required, so it becomes the local login.
  // A placeholder phone too, or the app sends every replay login to onboarding (+9725000000NN, never a real number).
  const emails = replayEmails(rebuilt.profiles ?? [], sadranId);
  const emailOf = (id) => emails.get(id) ?? `p-${id}@replay.local`;
  rebuilt.profiles = (rebuilt.profiles ?? []).map((p, i) => ({ ...p, email: emailOf(p.id), phone: `+97250000${String(i).padStart(4, "0")}` }));
  // Repeat-weekly templates are not exported (the solver never reads them); a dangling link would
  // fail the FK check of any later write to the request.
  rebuilt.requests = (rebuilt.requests ?? []).map((r) => ({ ...r, template_id: null }));
  // Answer tokens are left out too; a unique placeholder keeps the not-null/unique column valid (no link works locally).
  for (const table of ["proposals", "proposal_parties"]) {
    rebuilt[table] = (rebuilt[table] ?? []).map((row) => ({ ...row, token_hash: `replay:${row.id}` }));
  }

  const columns = insertableColumns(LOAD_ORDER);
  let sql = "begin;\nset session_replication_role = replica;\n";
  sql += deleteSql(dept, rebuilt);
  sql += authUsersSql(rebuilt.profiles ?? []);
  for (const table of LOAD_ORDER) sql += insertSql(table, rebuilt[table] ?? [], columns[table]);
  sql += "set session_replication_role = origin;\n";
  // Keep the replayed week still: no phase advance, reminders, expiries or housekeeping.
  sql += "select cron.alter_job(jobid, active := false) from cron.job where active;\n";
  sql += "commit;\n";
  psql(sql);

  const counts = psql(`select 'requests', count(*) from public.requests where department_id = ${quoteLiteral(dept)} and week_start = ${quoteLiteral(week)}
    union all select 'rides', count(*) from public.rides where department_id = ${quoteLiteral(dept)} and week_start = ${quoteLiteral(week)}
    union all select 'phase', 0 from public.weeks where department_id = ${quoteLiteral(dept)} and week_start = ${quoteLiteral(week)};`);
  const phase = psql(`select phase from public.weeks where department_id = ${quoteLiteral(dept)} and week_start = ${quoteLiteral(week)};`).trim();

  const nameOf = (id) => { const p = (t.profiles ?? []).find((x) => x.id === id); return p?.display_name ?? p?.full_name ?? id; };
  const out = path.resolve(args.out ?? path.join(ROOT, ".replay", "out", `${dept.slice(0, 8)}-${week}`));
  mkdirSync(out, { recursive: true });
  const home = t.departments[0].home_destination_id;
  writeFileSync(path.join(out, "world.json"), JSON.stringify({
    department: { id: dept, homePlaceId: home },
    weekStart: week,
    loadedAt: cut?.label ?? "now",
    sadran: sadranId ? { email: emailOf(sadranId), password: REPLAY_PASSWORD, name: nameOf(sadranId) } : undefined,
  }, null, 2));
  const logins = (t.profiles ?? []).map((p) => ({ name: p.display_name ?? p.full_name, email: emailOf(p.id), role: memberRole.get(p.id) ?? null, admin: !!p.is_admin }))
    .sort((a, b) => a.email.localeCompare(b.email, undefined, { numeric: true }));
  writeFileSync(path.join(out, "logins.json"), JSON.stringify(logins, null, 2));

  console.log(`replay: loaded department ${t.departments[0].name} (${dept}), week ${week}, at ${cut?.label ?? "now"}`);
  console.log(counts.trim().split("\n").filter((l) => !l.startsWith("phase")).map((l) => `  ${l.replace("|", ": ")}`).join("\n"));
  console.log(`  week phase: ${phase || "(no weeks row)"}`);
  console.log(`solver runs in the export:\n${describeRuns(t.solver_runs) || "  (none)"}`);
  console.log(`local logins (password ${REPLAY_PASSWORD}; full list in ${path.join(out, "logins.json")}):`);
  for (const l of logins.filter((x) => x.admin || x.email.startsWith("sadran@"))) console.log(`  ${l.email.padEnd(24)} ${l.name}${l.admin ? " (admin)" : ""}`);
  console.log(`re-run the solver: QA_API_URL=${REPLAY_API} npm run qa:sadran -- autofill --out ${path.relative(ROOT, out)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
