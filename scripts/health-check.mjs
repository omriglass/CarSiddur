#!/usr/bin/env node
// Read-only database health check (docs/TODO.md HC): runs invariant queries against the local
// Docker database or a hosted one and prints one line per check — level, row count, up to five
// sample ids — so broken data is found before a member finds it. Playbook: .claude/skills/health-check/SKILL.md.
//
// Usage:
//   node scripts/health-check.mjs [--container <name>] [--dept <uuid>] [--from <yyyy-mm-dd>] [--include-archived]
//   node scripts/health-check.mjs --db-url <postgres url> --yes-remote [...]      (or env HEALTH_DB_URL)
//
// Targets:
//   default   local Docker DB: `docker exec <container> psql`; container = --container, else env
//             SUPABASE_DB_CONTAINER, else supabase_db_<project_id from supabase/config.toml> (as scripts/test-db.mjs).
//   hosted    --db-url (or HEALTH_DB_URL), refused without --yes-remote (mirrors scripts/db-export.mjs).
//             Uses the local `psql`; the URL is split into PG* environment variables so the password never
//             appears in a process list, and it is never printed.
//
// Never writes: the whole run is one `begin read only; … rollback;` transaction, each check inside its own
// savepoint so one failing query (e.g. schema drift on an older hosted database) does not hide the others.
//
// Scope: weeks with week_start >= --from (default: 14 days before today, Asia/Jerusalem) that are not
// archived (--include-archived to add them), optionally one department. Time-window checks
// (outbox, client errors, notifications) are global — they are about the system, not a week.
//
// Exit codes: 0 = no `error` check has rows; 1 = at least one `error` check has rows (or a refused/invalid
// invocation); 2 = a check could not run / the database was unreachable (and no error rows were found).
//
// Never touches ../commucar-share.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SAMPLE_LIMIT = 5;

export function usage() {
  return `Usage: node scripts/health-check.mjs [options]

  --container <name>     Local Docker database container (default: env SUPABASE_DB_CONTAINER,
                         else supabase_db_<project_id> from supabase/config.toml).
  --db-url <url>         Hosted/remote Postgres URL (or env HEALTH_DB_URL). Needs --yes-remote
                         and a local psql (brew install libpq).
  --yes-remote           Confirms that reading the hosted database is intentional.
  --dept <uuid>          Only this department.
  --from <yyyy-mm-dd>    First week_start to look at (default: 14 days ago, Asia/Jerusalem).
  --include-archived     Also look at archived weeks (default: skipped).
  --help, -h             Show this help.

Read-only. One line per check: level, count, up to ${SAMPLE_LIMIT} sample ids. Exit 1 if any error check has rows.`;
}

export function parseArgs(argv, env = {}) {
  const args = {
    container: null,
    dbUrl: env.HEALTH_DB_URL || null,
    dbUrlExplicit: false,
    containerExplicit: false,
    yesRemote: false,
    dept: null,
    from: null,
    includeArchived: false,
    help: false,
    errors: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--container":
        args.container = argv[++i] ?? null;
        args.containerExplicit = true;
        break;
      case "--db-url":
        args.dbUrl = argv[++i] ?? null;
        args.dbUrlExplicit = true;
        break;
      case "--yes-remote":
        args.yesRemote = true;
        break;
      case "--dept":
        args.dept = argv[++i] ?? null;
        break;
      case "--from":
        args.from = argv[++i] ?? null;
        break;
      case "--include-archived":
        args.includeArchived = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        args.errors.push(`unknown argument "${a}"`);
    }
  }
  if (args.dept !== null && !UUID_RE.test(args.dept)) args.errors.push("--dept must be a department uuid");
  if (args.from !== null && !(DATE_RE.test(args.from) && !Number.isNaN(Date.parse(args.from)))) {
    args.errors.push("--from must be a date like 2026-10-04");
  }
  if (args.containerExplicit && !args.container) args.errors.push("--container needs a name");
  if (args.dbUrlExplicit && !args.dbUrl) args.errors.push("--db-url needs a value");
  if (args.dbUrlExplicit && args.containerExplicit) args.errors.push("use either --container or --db-url, not both");
  if (args.containerExplicit && !args.dbUrlExplicit) args.dbUrl = null; // an explicit container beats HEALTH_DB_URL
  return args;
}

/** Splits a postgres URL into PG* env vars (keeps the password out of argv). */
export function pgEnvFromUrl(raw) {
  const u = new URL(raw);
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error("--db-url must be a postgres:// URL");
  return {
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres",
    PGSSLMODE: u.searchParams.get("sslmode") || "require",
  };
}

// ---------------------------------------------------------------------------------------------
// Checks. Each check's `sql` selects (id text, detail text, n int) rows, already ordered; the count
// printed is sum(n), the samples are the first rows.
// ---------------------------------------------------------------------------------------------

const JT = (col) => `to_char(${col} at time zone 'Asia/Jerusalem', 'DD.MM HH24:MI')`;

export function scopeWeeks({ dept, from, includeArchived }) {
  const fromExpr = from ? `date '${from}'` : `((now() at time zone 'Asia/Jerusalem')::date - 14)`;
  const conds = [`w.week_start >= ${fromExpr}`];
  if (!includeArchived) conds.push(`w.phase <> 'archived'`);
  if (dept) conds.push(`w.department_id = '${dept}'`);
  return `(select w.department_id, w.week_start, w.phase from public.weeks w where ${conds.join(" and ")})`;
}

export function buildChecks(opts) {
  const W = scopeWeeks(opts);
  const inScope = (alias) => `join ${W} sw on sw.department_id = ${alias}.department_id and sw.week_start = ${alias}.week_start`;
  const todayLagged = `((now() - interval '30 minutes') at time zone 'Asia/Jerusalem')::date`;
  return [
    {
      id: "ride_overlap",
      level: "error",
      title: "two live rides overlap in time on one car (the rides_no_overlap_per_car constraint was bypassed)",
      sql: `select a.id::text,
        format('car %s %s-%s overlaps ride %s (%s-%s)', c.name, ${JT("a.starts_at")}, ${JT("a.ends_at")}, b.id, ${JT("b.starts_at")}, ${JT("b.ends_at")}), 1
      from public.rides a
      join public.rides b on b.car_id = a.car_id and b.id > a.id and b.status <> 'cancelled' and not b.planning_conflict
        and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)')
      join public.cars c on c.id = a.car_id
      ${inScope("a")}
      where a.status <> 'cancelled' and not a.planning_conflict
      order by a.starts_at, a.id`,
    },
    {
      id: "request_assigned_no_ride",
      level: "error",
      title: "request is assigned/merged but no non-cancelled ride serves it",
      sql: `select q.id::text, format('%s request, day %s, dept %s', q.status, ${JT("coalesce(q.depart_at, q.return_at)")}, q.department_id), 1
      from public.requests q
      ${inScope("q")}
      where q.status in ('assigned', 'merged')
        and not exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                        where rr.request_id = q.id and r.status <> 'cancelled')
      order by coalesce(q.depart_at, q.return_at), q.id`,
    },
    {
      id: "ride_confirmed_no_driver",
      level: "error",
      title: "confirmed ride without a driver (should be flagged / NEEDS_DRIVER); reservations without a driver are legitimate",
      sql: `select r.id::text, format('car %s %s, needs_driver=%s', c.name, ${JT("r.starts_at")}, r.needs_driver), 1
      from public.rides r
      join public.cars c on c.id = r.car_id
      ${inScope("r")}
      where r.status = 'confirmed'
        and (r.needs_driver or (r.driver_id is null and not public.ride_is_reservation(r.id)))
      order by r.starts_at, r.id`,
    },
    {
      id: "ride_on_retired_car",
      level: "error",
      title: "upcoming ride on a retired car",
      sql: `select r.id::text, format('car %s (retired) %s', c.name, ${JT("r.starts_at")}), 1
      from public.rides r
      join public.cars c on c.id = r.car_id and c.status = 'retired'
      ${inScope("r")}
      where r.status <> 'cancelled' and r.starts_at >= now()
      order by r.starts_at, r.id`,
    },
    {
      id: "ride_seat_config",
      level: "error",
      title: "a ride leg carries more adults / child seats / boosters than the car's seat configurations allow (assert_ride_seats_fit, via car_fits)",
      sql: `select l.ride_id::text, format('car %s leg %s needs %s adults / %s child seats / %s boosters', c.name, l.side, l.a, l.c, l.b), 1
      from (
        select rd.id as ride_id, rd.car_id, legs.side, rd.starts_at,
          (sum(q.adults)
            + case when not exists (select 1 from public.ride_requests x where x.ride_id = rd.id and x.role = 'driver')
                    and not exists (select 1 from public.ride_requests x join public.requests xq on xq.id = x.request_id
                                    where x.ride_id = rd.id and xq.requester_id = rd.driver_id
                                      and ((legs.side = 'out' and x.covers_out) or (legs.side = 'return' and x.covers_return)))
                   then 1 else 0 end)::int as a,
          sum(q.child_seats)::int as c, sum(q.boosters)::int as b
        from public.rides rd
        ${inScope("rd")}
        join public.ride_requests rr on rr.ride_id = rd.id
        join public.requests q on q.id = rr.request_id
        cross join lateral (values ('out'), ('return')) as legs(side)
        where rd.status <> 'cancelled'
          and ((legs.side = 'out' and rr.covers_out) or (legs.side = 'return' and rr.covers_return))
        group by rd.id, rd.car_id, rd.driver_id, rd.starts_at, legs.side
      ) l
      join public.cars c on c.id = l.car_id
      where not public.car_fits(l.car_id, l.a, l.c, l.b)
      order by l.starts_at, l.ride_id`,
    },
    {
      id: "ride_luggage_capacity",
      level: "error",
      title: "a ride leg carries a large-luggage request on a car without a large trunk (car_takes_luggage, yes/no)",
      sql: `select l.ride_id::text, format('car %s leg %s carries %s large-luggage request(s)', c.name, l.side, l.lug), 1
      from (
        select rd.id as ride_id, rd.car_id, legs.side, rd.starts_at, count(*) filter (where q.has_luggage)::int as lug
        from public.rides rd
        ${inScope("rd")}
        join public.ride_requests rr on rr.ride_id = rd.id
        join public.requests q on q.id = rr.request_id
        cross join lateral (values ('out'), ('return')) as legs(side)
        where rd.status <> 'cancelled'
          and ((legs.side = 'out' and rr.covers_out) or (legs.side = 'return' and rr.covers_return))
        group by rd.id, rd.car_id, rd.starts_at, legs.side
      ) l
      join public.cars c on c.id = l.car_id
      where l.lug > 0 and not public.car_takes_luggage(l.car_id, l.lug)
      order by l.starts_at, l.ride_id`,
    },
    {
      id: "ride_on_maintenance_car",
      level: "warn",
      title: "upcoming ride on a car whose status is 'maintenance' (admins may override; move or cancel the ride)",
      sql: `select r.id::text, format('car %s (maintenance) %s', c.name, ${JT("r.starts_at")}), 1
      from public.rides r
      join public.cars c on c.id = r.car_id and c.status = 'maintenance'
      ${inScope("r")}
      where r.status <> 'cancelled' and r.starts_at >= now()
      order by r.starts_at, r.id`,
    },
    {
      id: "ride_in_maintenance_block",
      level: "warn",
      title: "ride overlaps a car maintenance block (admins may override the guard; the trigger only stops non-admins)",
      sql: `select r.id::text, format('car %s %s overlaps block "%s" (%s-%s)', c.name, ${JT("r.starts_at")}, left(b.reason, 30), ${JT("b.starts_at")}, ${JT("b.ends_at")}), 1
      from public.rides r
      join public.cars c on c.id = r.car_id
      join public.car_maintenance_blocks b on b.car_id = r.car_id
        and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(r.starts_at, r.blocked_until, '[)')
      ${inScope("r")}
      where r.status <> 'cancelled' and r.ends_at > now()
      order by r.starts_at, r.id`,
    },
    {
      id: "request_leg_not_covered",
      level: "warn",
      title: "assigned/merged request has a live ride but a leg no ride covers (publication_readiness: incompleteAssignments)",
      sql: `select q.id::text, format('%s %s request, day %s', q.status, q.trip_shape, ${JT("coalesce(q.depart_at, q.return_at)")}), 1
      from public.requests q
      ${inScope("q")}
      where q.status in ('assigned', 'merged')
        and exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                    where rr.request_id = q.id and r.status <> 'cancelled')
        and not public.request_legs_placed(q.id)
      order by coalesce(q.depart_at, q.return_at), q.id`,
    },
    {
      id: "ride_needs_driver_published",
      level: "warn",
      title: "upcoming ride on a published day still needs a driver",
      sql: `select r.id::text, format('car %s %s, status %s', c.name, ${JT("r.starts_at")}, r.status), 1
      from public.rides r
      join public.cars c on c.id = r.car_id
      ${inScope("r")}
      where r.needs_driver and r.status <> 'cancelled' and sw.phase in ('published', 'live') and r.starts_at >= now()
        and public.is_day_public(r.department_id, r.week_start, (r.starts_at at time zone 'Asia/Jerusalem')::date)
      order by r.starts_at, r.id`,
    },
    {
      id: "ride_turnaround_overlap",
      level: "warn",
      title: "rides on one car start inside the previous ride's turnaround buffer (same-series legs exempt)",
      sql: `select b.id::text, format('car %s: ride %s ends %s (+%s min buffer), next starts %s', c.name, a.id, ${JT("a.ends_at")}, round(extract(epoch from a.turnaround) / 60), ${JT("b.starts_at")}), 1
      from public.rides a
      join public.rides b on b.car_id = a.car_id and b.id <> a.id and b.status <> 'cancelled' and not b.planning_conflict
        and b.starts_at >= a.ends_at and b.starts_at < a.blocked_until
        and not (a.series_id is not null and a.series_id = b.series_id)
      join public.cars c on c.id = a.car_id
      ${inScope("a")}
      where a.status <> 'cancelled' and not a.planning_conflict
      order by b.starts_at, b.id`,
    },
    {
      id: "car_chain_flagged",
      level: "warn",
      title: "ride flagged car_chain_broken (the car is not where the ride starts; flag_car_chain_breaks)",
      sql: `select r.id::text, format('car %s %s, status %s', c.name, ${JT("r.starts_at")}, r.status), 1
      from public.rides r
      join public.cars c on c.id = r.car_id
      ${inScope("r")}
      where r.flag_reason = 'car_chain_broken' and r.status <> 'cancelled' and not r.planning_conflict
      order by r.starts_at, r.id`,
    },
    {
      id: "car_chain_unflagged",
      level: "warn",
      title: "ride starts where its car is not (car_location_excluding) but is not flagged yet; same rule as flag_car_chain_breaks",
      sql: `select r.id::text, format('car %s %s starts at %s, car is at %s', c.name, ${JT("r.starts_at")}, coalesce(o.name, '?'), coalesce(l.name, '?')), 1
      from public.rides r
      join public.cars c on c.id = r.car_id
      ${inScope("r")}
      left join public.destinations o on o.id = r.origin_id
      cross join lateral (select public.car_location_excluding(r.car_id, r.starts_at, r.id) as loc) x
      left join public.destinations l on l.id = x.loc
      where r.status <> 'cancelled' and not r.planning_conflict
        and (not r.auto_relocation or r.driver_id is not null)
        and r.flag_reason is distinct from 'car_chain_broken'
        and x.loc is distinct from r.origin_id
        and not public.ride_is_reservation(r.id)
      order by r.starts_at, r.id`,
    },
    {
      id: "car_ends_week_away",
      level: "warn",
      title: "shared car's last ride of a published/live week ends away from the car's base",
      sql: `select c.id::text, format('car %s ends week %s at %s, base is %s', c.name, last.week_start, coalesce(dn.name, '?'), coalesce(bn.name, '?')), 1
      from (
        select distinct on (r.car_id, r.week_start) r.car_id, r.week_start, r.destination_id
        from public.rides r
        ${inScope("r")}
        where sw.phase in ('published', 'live') and r.status not in ('cancelled', 'draft') and not r.planning_conflict
          and not public.ride_is_reservation(r.id)
        order by r.car_id, r.week_start, r.starts_at desc, r.id desc
      ) last
      join public.cars c on c.id = last.car_id and c.type = 'shared'
      left join public.destinations dn on dn.id = last.destination_id
      left join public.destinations bn on bn.id = public.car_base_location(c.id)
      where last.destination_id is distinct from public.car_base_location(c.id)
      order by last.week_start, c.name, c.id`,
    },
    {
      id: "proposal_sent_not_expired",
      level: "warn",
      title: "sent proposal that expire_proposals() should have expired (request day passed, or day published for a non-Sadran-shift/merge proposal, or expires_at passed); cron lag > 30 min",
      sql: `select p.id::text, format('%s proposal (%s) for request %s, request day %s', p.type, p.created_via, p.request_id, x.d), 1
      from public.proposals p
      join public.requests q on q.id = p.request_id
      ${inScope("p")}
      cross join lateral (select (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date as d) x
      where p.status = 'sent'
        and (x.d < ${todayLagged}
          or (p.expires_at is not null and p.expires_at < now() - interval '30 minutes')
          or (public.is_day_public(p.department_id, p.week_start, x.d)
              and (p.type not in ('shift', 'merge') or p.created_via <> 'sadran')
              and exists (select 1 from public.weeks w where w.department_id = p.department_id and w.week_start = p.week_start
                          and w.updated_at < now() - interval '30 minutes')))
      order by x.d, p.id`,
    },
    {
      id: "proposal_draft_published_day",
      level: "warn",
      title: "draft proposal on a day that is already published (publish_siddur blocks drafts; this is a board edit left unsent)",
      sql: `select p.id::text, format('%s draft for request %s, request day %s', p.type, p.request_id, x.d), 1
      from public.proposals p
      join public.requests q on q.id = p.request_id
      ${inScope("p")}
      cross join lateral (select (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date as d) x
      where p.status = 'draft' and public.is_day_public(p.department_id, p.week_start, x.d)
      order by x.d, p.id`,
    },
    {
      id: "push_outbox_stuck",
      level: "warn",
      title: "push_outbox row pending for more than 1 hour (drain_push_outbox / push-dispatch not delivering)",
      sql: `select o.id::text, format('pending %s min, %s attempt(s), next attempt %s', round(extract(epoch from now() - o.created_at) / 60), o.attempts, ${JT("o.next_attempt_at")}), 1
      from public.push_outbox o
      where o.status = 'pending' and o.created_at < now() - interval '1 hour'
      order by o.created_at, o.id`,
    },
    {
      id: "push_outbox_failed_24h",
      level: "warn",
      title: "push_outbox rows failed or dead in the last 24 hours (last_error holds the reason; not printed here)",
      sql: `select o.id::text, format('%s after %s attempt(s), created %s', o.status, o.attempts, ${JT("o.created_at")}), 1
      from public.push_outbox o
      where o.status in ('failed', 'dead') and o.created_at > now() - interval '24 hours'
      order by o.created_at desc, o.id`,
    },
    {
      id: "week_phase_lag",
      level: "warn",
      title: "week phase lags the clock by more than 1 hour (app.tick / advance_week_phases stalled)",
      sql: `select w.department_id::text || ':' || w.week_start::text,
        case
          when w.phase = 'upcoming' then format('still upcoming, open_at was %s', ${JT("w.open_at")})
          when w.phase = 'open' then format('still open, close_at was %s', ${JT("w.close_at")})
          when w.week_start + 7 <= ((now() - interval '1 hour') at time zone 'Asia/Jerusalem')::date then format('%s but the week ended (should be archived)', w.phase)
          else 'published but the week already started (should be live)'
        end, 1
      from public.weeks w
      join ${W} sw on sw.department_id = w.department_id and sw.week_start = w.week_start
      where (w.phase = 'upcoming' and w.open_at < now() - interval '1 hour')
         or (w.phase = 'open' and w.close_at < now() - interval '1 hour')
         or (w.phase in ('published', 'live') and w.week_start + 7 <= ((now() - interval '1 hour') at time zone 'Asia/Jerusalem')::date)
         or (w.phase = 'published' and w.week_start
             <= (((now() - interval '1 hour') at time zone 'Asia/Jerusalem')::date
                 - extract(dow from (now() - interval '1 hour') at time zone 'Asia/Jerusalem')::int))
      order by w.week_start, w.department_id`,
    },
    {
      id: "client_errors_24h",
      level: "info",
      title: "client_errors in the last 24 hours (top messages; id column is the message)",
      sql: `select left(regexp_replace(message, '\\s+', ' ', 'g'), 80), format('%s x, latest %s, app %s', count(*), ${JT("max(created_at)")}, coalesce(max(app_version), '?')), count(*)::int
      from public.client_errors
      where created_at > now() - interval '24 hours'
      group by left(regexp_replace(message, '\\s+', ' ', 'g'), 80)
      order by count(*) desc, 1`,
    },
    {
      id: "notifications_24h",
      level: "info",
      title: "notifications queued in the last 24 hours (id column is the event)",
      sql: `select event::text, format('%s notification(s)', count(*)), count(*)::int
      from public.notifications
      where created_at > now() - interval '24 hours'
      group by event
      order by count(*) desc, 1`,
    },
  ];
}

/** The whole read-only psql script. Each check prints one `HC<TAB>id<TAB>count<TAB>json` line. */
export function buildScript(checks) {
  const lines = ["begin read only;", "set local statement_timeout = '60s';"];
  checks.forEach((c, i) => {
    const sp = `hc_${i}`;
    lines.push(`savepoint ${sp};`);
    lines.push(
      `select 'HC' || E'\\t' || '${c.id}' || E'\\t' || coalesce(sum(x.n), 0)::text || E'\\t' || ` +
        `coalesce(json_agg(json_build_object('id', x.id, 'd', x.detail) order by x.rn) filter (where x.rn <= ${SAMPLE_LIMIT}), '[]'::json)::text ` +
        `from (select q.id, q.detail, q.n, row_number() over () as rn from (${c.sql}) as q(id, detail, n)) as x;`,
    );
    lines.push(`rollback to savepoint ${sp};`);
  });
  lines.push("rollback;");
  return lines.join("\n") + "\n";
}

/** Parses psql stdout into Map<checkId, {count, samples}>; ignores any other line. */
export function parseResults(stdout) {
  const out = new Map();
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("HC\t")) continue;
    const [, id, count, json] = line.split("\t");
    let samples = [];
    try {
      samples = JSON.parse(json ?? "[]");
    } catch {
      samples = [];
    }
    out.set(id, { count: Number(count) || 0, samples });
  }
  return out;
}

const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function formatLine(check, result) {
  const level = result ? (result.count > 0 ? check.level.toUpperCase() : "ok") : "FAIL";
  const count = result ? String(result.count) : "-";
  const head = `${level.padEnd(5)} ${count.padStart(4)}  ${check.id}`;
  if (!result) return `${head}  check could not run (see database errors below)`;
  if (result.count === 0) return `${head}  ${check.title}`;
  const samples = result.samples.map((s) => `${trunc(String(s.id), 60)} (${trunc(String(s.d), 110)})`).join("; ");
  const more = result.count > result.samples.length ? " …" : "";
  return `${head}  ${check.title}\n        e.g. ${samples}${more}`;
}

export function exitCodeFor(checks, results) {
  if (checks.some((c) => c.level === "error" && (results.get(c.id)?.count ?? 0) > 0)) return 1;
  if (checks.some((c) => !results.has(c.id))) return 2;
  return 0;
}

export function summarize(checks, results) {
  const n = { error: 0, warn: 0, info: 0, failed: 0 };
  for (const c of checks) {
    const r = results.get(c.id);
    if (!r) n.failed++;
    else if (r.count > 0) n[c.level]++;
  }
  return `${n.error} error check(s) with rows, ${n.warn} warn, ${n.info} info with rows${n.failed ? `, ${n.failed} check(s) could not run` : ""}`;
}

// ---------------------------------------------------------------------------------------------

function defaultContainer(env) {
  if (env.SUPABASE_DB_CONTAINER) return env.SUPABASE_DB_CONTAINER;
  const config = readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");
  const projectId = /^project_id\s*=\s*"([^"]+)"/m.exec(config)?.[1];
  if (!projectId) throw new Error("Missing Supabase project_id in supabase/config.toml");
  return `supabase_db_${projectId}`;
}

function run(args, env) {
  const checks = buildChecks({ dept: args.dept, from: args.from, includeArchived: args.includeArchived });
  const script = buildScript(checks);
  const psqlFlags = ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=0"];
  let proc;
  let target;
  if (args.dbUrl) {
    let pgEnv;
    try {
      pgEnv = pgEnvFromUrl(args.dbUrl);
    } catch (e) {
      console.error(`health-check: ${e.message}`);
      return 1;
    }
    target = `hosted ${pgEnv.PGHOST}:${pgEnv.PGPORT}/${pgEnv.PGDATABASE}`;
    const probe = spawnSync("psql", ["--version"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      console.error(
        `health-check: a local psql is required for --db-url and was not found on PATH.\n` +
          `  macOS: brew install libpq, then add /opt/homebrew/opt/libpq/bin to PATH (or brew link --force libpq).\n` +
          `  Nothing is written or sent anywhere until psql exists; the hosted URL was not used.`,
      );
      return 1;
    }
    console.log(`health-check: target ${target} (read-only)`);
    proc = spawnSync("psql", psqlFlags, {
      input: script,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...env, ...pgEnv },
    });
  } else {
    const container = args.container || defaultContainer(env);
    target = `docker container ${container}`;
    console.log(`health-check: target ${target} (read-only)`);
    proc = spawnSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", ...psqlFlags], {
      input: script,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  }
  if (proc.error) {
    console.error(`health-check: could not run the database client: ${proc.error.message}`);
    return 2;
  }
  const results = parseResults(proc.stdout ?? "");
  if (results.size === 0) {
    console.error(`health-check: no results from ${target}.\n${(proc.stderr ?? "").trim()}`);
    return 2;
  }
  const scope = `from ${args.from ?? "14 days ago"}${args.includeArchived ? ", archived included" : ", non-archived"}${args.dept ? `, department ${args.dept}` : ", all departments"}`;
  console.log(`health-check: weeks ${scope}\n`);
  for (const level of ["error", "warn", "info"]) {
    for (const c of checks.filter((x) => x.level === level)) console.log(formatLine(c, results.get(c.id)));
  }
  const stderr = (proc.stderr ?? "").trim();
  if (stderr) console.error(`\ndatabase messages:\n${stderr}`);
  console.log(`\nhealth-check: ${summarize(checks, results)}`);
  return exitCodeFor(checks, results);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2), process.env);
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  if (args.errors.length) {
    console.error(`health-check: ${args.errors.join("; ")}\n\n${usage()}`);
    process.exit(1);
  }
  if (args.dbUrl && !args.yesRemote) {
    console.error(
      `health-check refuses to read a remote database without --yes-remote.\n` +
        `  It would run read-only queries against the target in --db-url / HEALTH_DB_URL (host ${(() => {
          try {
            return new URL(args.dbUrl).hostname;
          } catch {
            return "?";
          }
        })()}).\n` +
        `  Pass --yes-remote to confirm you intend to read the hosted database.`,
    );
    process.exit(1);
  }
  process.exit(run(args, process.env));
}
