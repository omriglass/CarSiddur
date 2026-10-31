#!/usr/bin/env node
// scripts/debug/debug.mjs — a local debug copy of production (`npm run debug -- <command>`).
//
// Production is only ever READ (a pg_dump and one SELECT); every write goes to the dedicated
// debug stack `carshare-debug` (API 60731, DB 60732, Studio 60733; the app on 6073). Its data is a
// full copy of production's `public` schema, cut down to the chosen weeks, with secrets stripped
// and a local login for every member. Dumps and logins live in `.debug/` (gitignored — they hold
// member names and rides; never commit or paste them). README: scripts/debug/README.md.
//
//   pull                          dump production (read-only) into .debug/dumps/<timestamp>/
//   load [--week this|next|prev|YYYY-MM-DD] [--with-previous] [--all] [--dump <dir>] [--migrate]
//                                 rebuild the debug database at production's schema from a dump
//                                 (default: the newest dump, this week + next week) — starts the stack if needed
//   migrate                       apply this branch's newer migrations on top (test a fix)
//   app                           the app on http://localhost:6073 against the debug stack
//   login <name|email>            a one-click sign-in link as that member (also: password login)
//   logins                        list every member's local login
//   status | stop
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { debugConfig, firstJsonObject, selectedWeeks } from "./lib.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEBUG_DIR = path.join(ROOT, ".debug");
const DUMPS_DIR = path.join(DEBUG_DIR, "dumps");
const WORKDIR = path.join(DEBUG_DIR, "stack");
const LOGINS_FILE = path.join(DEBUG_DIR, "logins.json");
const PROJECT_ID = "carshare-debug";
const DB_CONTAINER = `supabase_db_${PROJECT_ID}`;
const API_URL = "http://127.0.0.1:60731";
const APP_PORT = 6073;
const APP_URL = `http://localhost:${APP_PORT}`;
const PASSWORD = "debug-local-1234";
// Only what the app needs (db, auth, rest, kong, realtime) plus Studio to look around.
const EXCLUDED = "storage-api,imgproxy,logflare,vector,edge-runtime,mailpit,supavisor";

function fail(message) {
  console.error(`debug: ${message}`);
  process.exit(1);
}

function supabase(args, opts = {}) {
  return spawnSync("npx", ["supabase", ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
}

/** psql inside the debug stack's database container — never any other container. */
function psql(sql, { quiet = true } = {}) {
  const res = spawnSync(
    "docker",
    ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-X", ...(quiet ? ["-q"] : []), "-At"],
    { input: sql, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  if (res.status !== 0) throw new Error(`psql failed:\n${(res.stderr || res.stdout).slice(-4000)}`);
  return res.stdout;
}

function isRunning() {
  const res = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
  return (res.stdout ?? "").split("\n").includes(DB_CONTAINER);
}

const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;

function parseArgs(argv) {
  const args = { _: [], week: null, withPrevious: false, all: false, dump: null, migrate: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--week") args.week = argv[++i];
    else if (a === "--with-previous") args.withPrevious = true;
    else if (a === "--all") args.all = true;
    else if (a === "--dump") args.dump = argv[++i];
    else if (a === "--migrate") args.migrate = true;
    else if (a.startsWith("--")) fail(`unknown option ${a}`);
    else args._.push(a);
  }
  return args;
}

// ---------------------------------------------------------------- pull (production, read-only)

function jerusalemStamp(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}_${get("hour")}${get("minute")}`;
}

/** One read-only SELECT against the linked project; returns its rows. */
function prodQuery(sql) {
  const res = supabase(["db", "query", "--linked", sql]);
  if (res.status !== 0) fail(`production query failed:\n${res.stderr || res.stdout}`);
  return firstJsonObject(res.stdout).rows;
}

function pull() {
  const dir = path.join(DUMPS_DIR, jerusalemStamp());
  mkdirSync(dir, { recursive: true });
  console.log("debug: reading production (read-only: pg_dump of `public` data + one SELECT)…");
  const [meta] = prodQuery("select now() as pulled_at, (select coalesce(json_agg(version order by version), '[]') from supabase_migrations.schema_migrations) as migrations");
  const dump = supabase(["db", "dump", "--linked", "--data-only", "--use-copy", "--schema", "public", "-f", path.join(dir, "data.sql")], { stdio: "inherit" });
  if (dump.status !== 0) fail("pg_dump failed");
  writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ pulledAt: meta.pulled_at, migrations: meta.migrations }, null, 2));
  console.log(`debug: wrote ${path.relative(ROOT, dir)} (production at migration ${meta.migrations.at(-1)})`);
  return dir;
}

function latestDump() {
  if (!existsSync(DUMPS_DIR)) return null;
  const dirs = readdirSync(DUMPS_DIR).filter((d) => existsSync(path.join(DUMPS_DIR, d, "meta.json"))).sort();
  return dirs.length ? path.join(DUMPS_DIR, dirs.at(-1)) : null;
}

// ---------------------------------------------------------------- stack

/**
 * A copy of supabase/ under .debug/stack with its own project id, ports 6073x, no seed, the
 * app URL on 6073 — and only the migrations production has (`onlyVersions`), or all of them.
 */
function syncWorkdir(onlyVersions) {
  const target = path.join(WORKDIR, "supabase");
  mkdirSync(WORKDIR, { recursive: true });
  rmSync(path.join(target, "migrations"), { recursive: true, force: true });
  cpSync(path.join(ROOT, "supabase"), target, {
    recursive: true,
    filter: (src) => !/[\\/]supabase[\\/](\.temp|\.branches|tests|snippets|rollback)([\\/]|$)/.test(src),
  });
  if (onlyVersions) {
    const keep = new Set(onlyVersions);
    const migrations = path.join(target, "migrations");
    const local = readdirSync(migrations);
    const missing = onlyVersions.filter((v) => !local.some((f) => f.startsWith(`${v}_`)));
    if (missing.length) fail(`production has migrations this checkout lacks: ${missing.join(", ")} — check out the released code first`);
    for (const file of local) if (!keep.has(file.split("_")[0])) rmSync(path.join(migrations, file));
  }
  const configPath = path.join(target, "config.toml");
  const config = debugConfig(readFileSync(configPath, "utf8"), { projectId: PROJECT_ID, appUrl: APP_URL });
  writeFileSync(configPath, config);
}

function startOrReset() {
  if (isRunning()) {
    console.log("debug: resetting the debug database to production's schema…");
    const res = supabase(["db", "reset", "--local", "--workdir", WORKDIR], { stdio: "inherit" });
    if (res.status !== 0) fail("db reset failed");
  } else {
    console.log("debug: starting the debug stack (first start takes a few minutes)…");
    const res = supabase(["start", "-x", EXCLUDED, "--workdir", WORKDIR], { stdio: "inherit" });
    if (res.status !== 0) fail("supabase start failed");
  }
}

function stackKeys() {
  const res = supabase(["status", "-o", "env", "--workdir", WORKDIR]);
  if (res.status !== 0) fail("debug stack is not running — `npm run debug -- load` first");
  const env = Object.fromEntries(res.stdout.split("\n").map((l) => l.match(/^([A-Z_]+)="?(.*?)"?$/)).filter(Boolean).map((m) => [m[1], m[2]]));
  return { anon: env.ANON_KEY, service: env.SERVICE_ROLE_KEY };
}

// ---------------------------------------------------------------- load

/** Everything after the raw data has landed: cut weeks, strip secrets, logins, still clock. */
function afterLoadSql(weeks) {
  const weekList = weeks ? `array[${weeks.map((w) => `${quote(w)}::date`).join(",")}]` : "null";
  return `
-- Keep only the chosen weeks: week-scoped rows of other weeks go. FK checks are off in replica mode, so
-- then every row pointing at a row that is gone is fixed until nothing dangles: an optional one-column
-- link is cleared (the row stays — e.g. this week's request made from a template of an older week's
-- request), a required one deletes the row. What was cleared/deleted is listed in debug_prune_log.
create table if not exists public._debug_prune_log(tbl text, fk text, action text, n bigint);
do $$
declare keep date[] := ${weekList}; wt record; fk record; n bigint; total bigint; nullable boolean;
begin
  if keep is null then return; end if;
  for wt in select c.relname from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace s on s.oid = c.relnamespace
           where s.nspname = 'public' and c.relkind = 'r' and a.attname = 'week_start' and not a.attisdropped and c.relname <> '_debug_prune_log' loop
    execute format('delete from public.%I where week_start is not null and week_start <> all($1)', wt.relname) using keep;
  end loop;
  loop
    total := 0;
    for fk in select con.conname, con.conrelid, con.conrelid::regclass as child, con.confrelid::regclass as parent, con.conkey, con.confdeltype,
                    array(select format('%I', attname) from unnest(con.conkey) with ordinality k(n, i) join pg_attribute on attrelid = con.conrelid and attnum = k.n order by k.i) as cols,
                    array(select format('%I', attname) from unnest(con.confkey) with ordinality k(n, i) join pg_attribute on attrelid = con.confrelid and attnum = k.n order by k.i) as pcols
             from pg_constraint con join pg_namespace s on s.oid = con.connamespace
             join pg_class pc on pc.oid = con.confrelid join pg_namespace ps on ps.oid = pc.relnamespace
             where con.contype = 'f' and s.nspname = 'public' and ps.nspname = 'public' loop
      select cardinality(fk.conkey) = 1 and fk.confdeltype <> 'c' and not a.attnotnull into nullable
      from pg_attribute a where a.attrelid = fk.conrelid and a.attnum = fk.conkey[1];
      execute format(case when nullable then 'update %1$s x set %5$s = null where %2$s and not exists (select 1 from %3$s p where %4$s)'
                          else 'delete from %1$s x where %2$s and not exists (select 1 from %3$s p where %4$s)' end,
        fk.child,
        (select string_agg(format('x.%s is not null', col), ' and ') from unnest(fk.cols) col),
        fk.parent,
        (select string_agg(format('p.%s = x.%s', fk.pcols[i], fk.cols[i]), ' and ') from generate_subscripts(fk.cols, 1) i),
        fk.cols[1]);
      get diagnostics n = row_count;
      if n > 0 then insert into public._debug_prune_log values (fk.child::text, fk.conname, case when nullable then 'cleared' else 'deleted' end, n); end if;
      total := total + n;
    end loop;
    exit when total = 0;
  end loop;
end $$;

-- Secrets and anything that could reach the outside world.
delete from public.push_subscriptions;
delete from public.push_outbox;
delete from public.app_secrets;
update public.app_settings set value = jsonb_build_object('value', '') where key like '%\\_url' escape '\\';
update public.car_access_codes set access_code = case when access_code is null then null else '1234' end,
  replacement_code = case when replacement_code is null then null else '5678' end;
update public.member_invites set email = 'invite-' || left(id::text, 8) || '@debug.local', phone = null;
update public.proposals set token_hash = 'debug:' || id where token_hash is not null;
update public.proposal_parties set token_hash = 'debug:' || id where token_hash is not null;
-- A local login per profile: email p-<id8>@debug.local, a placeholder phone (else onboarding).
update public.profiles p set email = 'p-' || left(p.id::text, 8) || '@debug.local',
  phone = '+97250' || lpad(x.n::text, 7, '0')
from (select id, row_number() over (order by id) as n from public.profiles) x where x.id = p.id;
delete from auth.identities;
delete from auth.users;
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
select '00000000-0000-0000-0000-000000000000', p.id, 'authenticated', 'authenticated', p.email,
  crypt(${quote(PASSWORD)}, gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', p.full_name), now(), now(), '', '', '', ''
from public.profiles p;
insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), p.id, p.id::text, jsonb_build_object('sub', p.id::text, 'email', p.email), 'email', now(), now(), now()
from public.profiles p;
`;
}

function load(args) {
  const dumpDir = args.dump ? path.resolve(args.dump) : latestDump() ?? pull();
  if (!existsSync(path.join(dumpDir, "data.sql"))) fail(`no data.sql in ${dumpDir}`);
  const meta = JSON.parse(readFileSync(path.join(dumpDir, "meta.json"), "utf8"));
  const weeks = selectedWeeks(args, meta.pulledAt);
  console.log(`debug: dump ${path.relative(ROOT, dumpDir)} (pulled ${meta.pulledAt}), weeks: ${weeks ? weeks.join(", ") : "all"}`);

  syncWorkdir(meta.migrations);
  startOrReset();

  const tables = psql("select string_agg(format('public.%I', tablename), ', ') from pg_tables where schemaname = 'public';").trim();
  const sql = [
    "begin;",
    "set session_replication_role = replica;",
    // Migrations seed catalogs (templates, fragments…); production's rows replace them all.
    `truncate ${tables} restart identity cascade;`,
    readFileSync(path.join(dumpDir, "data.sql"), "utf8"),
    "set session_replication_role = replica;",
    afterLoadSql(weeks),
    "set session_replication_role = origin;",
    // Keep the copy still: no phase advance, reminders, expiries, pushes or housekeeping.
    "select cron.alter_job(jobid, active := false) from cron.job where active;",
    "commit;",
  ].join("\n");
  psql(sql);

  const pruned = psql("select coalesce(string_agg(format('%s %s %s (%s)', action, sum, tbl, fk), E'\\n' order by tbl, fk), '') from (select tbl, fk, action, sum(n) from public._debug_prune_log group by 1, 2, 3) x;").trim();
  psql("drop table public._debug_prune_log;");
  if (pruned) console.log(`debug: rows pointing at other weeks:\n${pruned.replace(/^/gm, "  ")}`);
  if (args.migrate) migrate();
  writeLogins();
  const counts = psql(`select string_agg(format('%s %s', t, n), ', ') from (
    select 'weeks' t, count(*) n from public.weeks union all select 'requests', count(*) from public.requests
    union all select 'rides', count(*) from public.rides union all select 'members', count(*) from public.profiles
    union all select 'client_errors', count(*) from public.client_errors) x;`).trim();
  console.log(`debug: loaded — ${counts}`);
  console.log(`debug: next: npm run debug -- app   (then: npm run debug -- login <name>)`);
}

function migrate() {
  syncWorkdir(null);
  const res = supabase(["migration", "up", "--local", "--workdir", WORKDIR], { stdio: "inherit" });
  if (res.status !== 0) fail("migration up failed");
}

function writeLogins() {
  const rows = JSON.parse(psql(`select coalesce(json_agg(x order by x.name), '[]') from (
    select p.id, coalesce(p.display_name, p.full_name) as name, p.email, p.is_admin as admin,
      (select string_agg(d.name || ':' || m.role, ', ' order by d.name) from public.department_members m join public.departments d on d.id = m.department_id
        where m.profile_id = p.id and m.removed_at is null) as departments
    from public.profiles p) x;`));
  mkdirSync(DEBUG_DIR, { recursive: true });
  writeFileSync(LOGINS_FILE, JSON.stringify(rows, null, 2));
}

// ---------------------------------------------------------------- app & login

function app() {
  if (!isRunning()) fail("debug stack is not running — `npm run debug -- load` first");
  const keys = stackKeys();
  console.log(`debug: app on ${APP_URL} (sign in: npm run debug -- login <name>, or the dev form with password ${PASSWORD})`);
  const child = spawn("npx", ["vite", "--port", String(APP_PORT), "--strictPort"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, VITE_SUPABASE_URL: API_URL, VITE_SUPABASE_ANON_KEY: keys.anon, VITE_APP_URL: APP_URL, VITE_VAPID_PUBLIC_KEY: process.env.VITE_VAPID_PUBLIC_KEY ?? "debug-no-push" },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

function readLogins() {
  if (!existsSync(LOGINS_FILE)) fail("no logins yet — `npm run debug -- load` first");
  return JSON.parse(readFileSync(LOGINS_FILE, "utf8"));
}

async function login(query) {
  if (!query) fail("usage: npm run debug -- login <name|email>");
  const matches = readLogins().filter((l) => l.email === query || (l.name ?? "").includes(query));
  if (!matches.length) fail(`no member matches "${query}" (npm run debug -- logins)`);
  if (matches.length > 1) {
    console.log(`debug: ${matches.length} members match — be more specific:`);
    for (const l of matches) console.log(`  ${l.name}  ${l.email}`);
    process.exit(1);
  }
  const [who] = matches;
  const keys = stackKeys();
  const res = await fetch(`${API_URL}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: { apikey: keys.service, Authorization: `Bearer ${keys.service}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", email: who.email, redirect_to: `${APP_URL}/` }),
  });
  const body = await res.json();
  if (!res.ok) fail(`generate_link failed: ${JSON.stringify(body)}`);
  console.log(`${who.name} (${who.departments ?? "no department"}) — open in a private window:\n${body.action_link ?? body.properties?.action_link}`);
  console.log(`or the dev form: ${who.email} / ${PASSWORD}`);
}

// ---------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = args._;
try {
  if (cmd === "pull") pull();
  else if (cmd === "load") load(args);
  else if (cmd === "migrate") migrate();
  else if (cmd === "app") app();
  else if (cmd === "login") await login(rest.join(" "));
  else if (cmd === "logins") for (const l of readLogins()) console.log(`${(l.name ?? "").padEnd(24)} ${l.email.padEnd(26)} ${l.departments ?? ""}${l.admin ? " (admin)" : ""}`);
  else if (cmd === "status") console.log(isRunning() ? `debug stack: running (${API_URL}, Studio http://127.0.0.1:60733, app ${APP_URL})` : "debug stack: not running");
  else if (cmd === "stop") process.exit(supabase(["stop", "--workdir", WORKDIR], { stdio: "inherit" }).status ?? 1);
  else {
    console.error("usage: npm run debug -- <pull|load|migrate|app|login|logins|status|stop>  (scripts/debug/README.md)");
    process.exit(2);
  }
} catch (err) {
  fail(err.message);
}
