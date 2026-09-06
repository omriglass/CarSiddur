-- Extensions, schemas, enums and shared utility functions.
-- REQ §5, §6, §7, §9; DATA_MODEL.md §0, §2, §6 step 1.

create extension if not exists pgcrypto;
create extension if not exists btree_gist;
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Holds the cron entry point (app.tick()) so it is not exposed through PostgREST.
create schema if not exists app;

-- ---------------------------------------------------------------------------
-- Enums (DATA_MODEL §2)
-- ---------------------------------------------------------------------------

create type public.role                 as enum ('member','sadran','admin');
create type public.approval_status      as enum ('pending','approved','blocked');
create type public.week_phase           as enum ('open','solving','published','live','archived');
create type public.request_status       as enum ('draft','submitted','proposed','assigned','merged',
                                                 'waitlisted','denied','external','withdrawn','cancelled');
create type public.trip_shape           as enum ('round_trip','one_way_to','one_way_from');   -- REQ §5.1, §5.4
create type public.leg_car_mode         as enum ('keep','relay','passenger','chauffeur');     -- REQ §5.4
create type public.home_week_preference as enum ('auto','live','open');                        -- REQ §5.5
create type public.ride_status          as enum ('draft','confirmed','flagged','cancelled');
create type public.ride_role            as enum ('driver','passenger');
create type public.ride_leg             as enum ('out','return','both');
create type public.proposal_type        as enum ('shift','merge','deny','external');
create type public.proposal_status      as enum ('draft','sent','accepted','declined','expired','applied','withdrawn');
create type public.party_response       as enum ('pending','accepted','declined');
create type public.car_type             as enum ('shared','temporary');
create type public.car_status           as enum ('active','maintenance','retired');
create type public.car_issue_status     as enum ('open','resolved');
create type public.solver_run_status    as enum ('succeeded','failed');
create type public.freed_offer_status   as enum ('open','auto_assigned','pending_approval','approved','expired','closed');
create type public.freed_claim_status   as enum ('offered','claimed','approved','declined','withdrawn');
create type public.notification_channel as enum ('push','inbox','whatsapp','email');
-- Canonical list = UX_FLOWS.md §6.1 (18 events) plus the two Sadran-only additions of
-- ARCHITECTURE.md §9 / DATA_MODEL.md §2 notes (window_closed_solve_now, publish_reminder) = 20 events.
create type public.notification_event   as enum ('window_open','window_closing','window_closed_solve_now','publish_reminder',
                                                 'published','outcome_changed',
                                                 'proposal_received','proposal_answered','freed_slot','freed_slot_auto',
                                                 'claim_approved','claim_declined','claim_contested','maintenance_affects',
                                                 'late_request','waitlisted_request','auto_approved','request_changed',
                                                 'access_request','access_approved');
create type public.push_outbox_status   as enum ('pending','sent','failed','dead');
create type public.answer_channel       as enum ('token','session','sadran');
create type public.audit_action         as enum ('insert','update','delete');

-- ---------------------------------------------------------------------------
-- Shared utility functions (DATA_MODEL §0, §5.1)
-- ---------------------------------------------------------------------------

-- Maintains updated_at on every table that has one.
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Optimistic concurrency: bumps version on every UPDATE of a state table.
create or replace function public.bump_version() returns trigger
language plpgsql as $$
begin
  new.version = old.version + 1;
  return new;
end;
$$;

-- Attached to immutable history tables (policy_versions, siddur_versions).
create or replace function public.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'Changing a % never rewrites history', tg_table_name
    using errcode = '0A000';
end;
$$;

-- 15-minute grid check; null-safe (a CHECK with a null argument passes, which is
-- correct for nullable columns like requests.depart_at on a one-way shape).
create or replace function public.is_quarter_hour(_t timestamptz) returns boolean
language sql immutable as $$
  select extract(epoch from _t)::bigint % 900 = 0;
$$;

-- Immutable span for a request: a round trip spans [depart, return]; a one-way
-- request spans a single instant. No interval arithmetic, so it can back a
-- GiST index (DATA_MODEL §3.6, §5.1).
create or replace function public.request_span(_depart timestamptz, _return timestamptz) returns tstzrange
language sql immutable as $$
  select tstzrange(coalesce(_depart, _return), coalesce(_return, _depart), '[]');
$$;

-- Asia/Jerusalem calendar-week bounds for a week_start (Sunday), as a tstzrange.
create or replace function public.week_range(_week_start date) returns tstzrange
language sql stable as $$
  select tstzrange(
    (_week_start::timestamp at time zone 'Asia/Jerusalem'),
    ((_week_start + 7)::timestamp at time zone 'Asia/Jerusalem'),
    '[)'
  );
$$;

-- Sunday (Asia/Jerusalem) of the week containing now(). stable, not immutable
-- (at time zone depends on tz data); never used in an index (DATA_MODEL §4.2).
create or replace function public.current_week_start() returns date
language sql stable as $$
  select (date_trunc('week', (now() at time zone 'Asia/Jerusalem') + interval '1 day') - interval '1 day')::date;
$$;
