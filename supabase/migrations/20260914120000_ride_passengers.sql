-- Named people on a ride, independent of a `requests` row (REQ §13.82; DATA_MODEL rides).
--
-- Two owner asks converge on one table (docs/TODO.md "F3 — Board reservation: optional named
-- people" + "Next feature (priority 3): add passengers to a ride by button"):
--   1. A Sadran-made manual reservation ("שמירת זמן") can now name who is on it. The first
--      person picked becomes the ride's driver (owner A5, 2026-09-14) via `edit_ride`'s existing
--      `driver_id` column — unchanged here. Everyone else picked (plus any named children) is a
--      `ride_passengers` row with no request behind them.
--   2. The same table is the base for the not-yet-built "+ נוסעים" button that lets anyone add
--      named passengers to any published ride (that UI is out of scope for this change; only
--      the table/RPC are built now, reusably).
--
-- `set_ride_passengers()` replaces a ride's passenger list in one transaction (mirrors
-- `set_request_companions()`, 20260910099600), checked for seat capacity (car seats minus the
-- ride's served `ride_requests` load minus these rows), bumps the ride's `version` (optimistic
-- concurrency, `stale_version` on mismatch), and notifies each newly-added `person_id` once.
--
-- Notification choice: `outcome_changed` / variant `reservation_added` — not a new event. Every
-- other "your ride assignment changed" notice already uses `outcome_changed`
-- (`ride_cancelled`, `driver_claimed`, `driver_cancelled`), `notification_default_url()` already
-- resolves an `outcome_changed` row carrying `ride_id` to `/siddur/<dept>/<week>?ride=<id>`
-- (exactly the right deep link here), and it is not one of the Sadran-role events that bypass a
-- mute — a member who muted `outcome_changed` should not be re-notified just because a Sadran
-- named them on a reservation. A brand-new event would need its own migration touch to
-- `notification_default_url`, docs and admin templates screen for no behavioral gain.

create table public.ride_passengers (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null references public.rides(id) on delete cascade,
  department_id uuid not null references public.departments(id),
  week_start date not null,
  person_id uuid references public.profiles(id),
  child_id uuid references public.children(id),
  display_name text not null check (length(trim(display_name)) between 1 and 100),
  seat_kind text not null check (seat_kind in ('adult', 'child_seat', 'booster')),
  added_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ride_passengers_week_fk foreign key (department_id, week_start) references public.weeks (department_id, week_start),
  -- A passenger is a profile, a named child, or a free-text guest — never a profile *and* a child.
  constraint ride_passengers_one_link_ck check (person_id is null or child_id is null)
);

create unique index ride_passengers_person_unique_idx on public.ride_passengers (ride_id, person_id) where person_id is not null;
create unique index ride_passengers_child_unique_idx on public.ride_passengers (ride_id, child_id) where child_id is not null;
create index ride_passengers_ride_idx on public.ride_passengers (ride_id);
create index ride_passengers_person_week_idx on public.ride_passengers (person_id, week_start);

create trigger set_updated_at before update on public.ride_passengers
  for each row execute function public.set_updated_at();
create trigger audit_row after insert or update or delete on public.ride_passengers
  for each row execute function public.audit_row();

alter table public.ride_passengers enable row level security;
alter table public.ride_passengers force row level security;

-- Department members read it once the week is public or they can manage it; a named person
-- always sees their own row (DATA_MODEL §4.2 helpers). No direct insert/update/delete policy —
-- `set_ride_passengers()` is the only write path.
create policy ride_passengers_select on public.ride_passengers for select to authenticated
using (
  public.member_of(department_id)
  and (
    public.is_week_public(department_id, week_start)
    or public.can_manage_week(department_id, week_start)
    or person_id = (select auth.uid())
  )
);

-- ---------------------------------------------------------------------------
-- set_ride_passengers: replace a ride's named-passenger list in one transaction.
-- p_passengers: [{ person_id?, child_id?, display_name, seat_kind }]
-- ---------------------------------------------------------------------------
create or replace function public.set_ride_passengers(p_ride_id uuid, p_expected_version int, p_passengers jsonb)
returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_ride public.rides%rowtype;
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_item jsonb;
  v_person_id uuid;
  v_child_id uuid;
  v_display_name text;
  v_seat_kind text;
  v_old_person_ids uuid[];
  v_new_person_ids uuid[] := '{}';
  v_added_person_ids uuid[];
  v_existing_a int; v_existing_c int; v_existing_b int;
  v_new_a int := 0; v_new_c int := 0; v_new_b int := 0;
  v_chauffeur_bonus int;
  v_new_version int;
begin
  select * into v_ride from public.rides where id = p_ride_id for update;
  if not found or v_ride.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_ride.department_id, v_ride.week_start) and v_ride.driver_id is distinct from v_actor then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_expected_version is null or v_ride.version <> p_expected_version then
    perform public.raise_stale_version();
  end if;
  if exists (select 1 from public.weeks where department_id = v_ride.department_id and week_start = v_ride.week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;

  select array_agg(person_id) filter (where person_id is not null) into v_old_person_ids
  from public.ride_passengers where ride_id = p_ride_id;

  -- Validate every row and total the new seat load before writing anything.
  for v_item in select * from jsonb_array_elements(coalesce(p_passengers, '[]'::jsonb))
  loop
    v_person_id := nullif(v_item ->> 'person_id', '')::uuid;
    v_child_id := nullif(v_item ->> 'child_id', '')::uuid;
    v_display_name := nullif(trim(coalesce(v_item ->> 'display_name', '')), '');
    v_seat_kind := v_item ->> 'seat_kind';
    if v_person_id is not null and v_child_id is not null then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;
    if v_display_name is null then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;
    if v_person_id is not null and not exists (
      select 1 from public.profiles p join public.department_members dm on dm.profile_id = p.id
      where p.id = v_person_id and p.approval_status = 'approved'
        and dm.department_id = v_ride.department_id and dm.removed_at is null
    ) then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;
    if v_child_id is not null and not exists (
      select 1 from public.children c where c.id = v_child_id and c.department_id = v_ride.department_id
    ) then
      raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end if;
    if v_person_id is not null then
      v_new_person_ids := v_new_person_ids || v_person_id;
    end if;
    case v_seat_kind
      when 'adult' then v_new_a := v_new_a + 1;
      when 'child_seat' then v_new_c := v_new_c + 1;
      when 'booster' then v_new_b := v_new_b + 1;
      else raise exception 'invalid_ride_passenger' using errcode = 'P0001';
    end case;
  end loop;

  if cardinality(v_new_person_ids) <> (select count(distinct x) from unnest(v_new_person_ids) x) then
    raise exception 'invalid_ride_passenger' using errcode = 'P0001';
  end if;

  -- Seat capacity: car seats minus the ride's served `ride_requests` load (with the same
  -- driver-has-no-request-of-their-own bonus `assert_ride_seats_fit` applies) minus these rows.
  select coalesce(sum(q.adults), 0), coalesce(sum(q.child_seats), 0), coalesce(sum(q.boosters), 0)
    into v_existing_a, v_existing_c, v_existing_b
  from public.ride_requests rr join public.requests q on q.id = rr.request_id
  where rr.ride_id = p_ride_id;

  v_chauffeur_bonus := case when v_ride.driver_id is not null
    and not exists (select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.role = 'driver')
    then 1 else 0 end;

  if not public.car_fits(v_ride.car_id, v_existing_a + v_chauffeur_bonus + v_new_a, v_existing_c + v_new_c, v_existing_b + v_new_b) then
    raise exception 'ride_seats_exceeded' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'set_ride_passengers', true);

  delete from public.ride_passengers where ride_id = p_ride_id;
  for v_item in select * from jsonb_array_elements(coalesce(p_passengers, '[]'::jsonb))
  loop
    insert into public.ride_passengers (ride_id, department_id, week_start, person_id, child_id, display_name, seat_kind, added_by)
    values (p_ride_id, v_ride.department_id, v_ride.week_start,
      nullif(v_item ->> 'person_id', '')::uuid, nullif(v_item ->> 'child_id', '')::uuid,
      trim(v_item ->> 'display_name'), v_item ->> 'seat_kind', v_actor);
  end loop;

  -- Optimistic concurrency: any update fires `bump_version()` (20260907090800_rides.sql).
  update public.rides set updated_at = now() where id = p_ride_id
  returning version into v_new_version;

  select array_agg(x) into v_added_person_ids
  from unnest(v_new_person_ids) x
  where x <> all (coalesce(v_old_person_ids, '{}'::uuid[])) and x is distinct from v_actor;

  if v_added_person_ids is not null then
    select full_name into v_actor_name from public.profiles where id = v_actor;
    for v_person_id in select unnest(v_added_person_ids) loop
      perform public.enqueue_notification(v_person_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
        jsonb_build_object('byName', coalesce(v_actor_name, '')),
        jsonb_build_object('variant', 'reservation_added', 'ride_id', p_ride_id),
        format('reservation_added:%s:%s:%s', p_ride_id, v_new_version, v_person_id));
    end loop;
  end if;
end;
$$;

revoke execute on function public.set_ride_passengers(uuid, int, jsonb) from public, anon;
grant execute on function public.set_ride_passengers(uuid, int, jsonb) to authenticated;

-- Hebrew copy (hard rule 3): reservation_added variant of the existing `outcome_changed` event.
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'outcome_changed', ch, 'reservation_added', t.title, t.body, t.title, t.body
from (values ('נשמר לך מקום ברכב', '{{byName}} שמר/ה לך מקום ברכב {{car}} ביום {{day}} ({{notes}})')) as t(title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do nothing;

-- Extend the ride-cancellation passenger notice (20260909092000, latest body in
-- 20260910099400_lock_cancel_and_move_series.sql) so named `ride_passengers` are told too, not
-- only requesters served via `ride_requests`. Reproduced verbatim with one added loop.
create or replace function public.cancel_ride_without_passengers(p_ride_id uuid, p_reason text, p_expected_version int default null) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_ride record;
  v_is_relay boolean;
  v_offer_id uuid;
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_served record;
  v_passenger record;
begin
  select * into v_ride from public.rides where id = p_ride_id for update;
  if v_ride is null or v_ride.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if v_ride.driver_id <> v_actor and not public.can_manage_week(v_ride.department_id, v_ride.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_expected_version is null or v_ride.version <> p_expected_version then
    perform public.raise_stale_version();
  end if;

  perform set_config('app.audit_reason', coalesce(p_reason, 'cancel_ride'), true);

  select exists (select 1 from public.ride_requests rr where rr.ride_id = p_ride_id and rr.car_mode = 'relay')
    into v_is_relay;

  update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor,
    cancel_reason = coalesce(p_reason, 'CANCELLED_BY_MEMBER')
  where id = p_ride_id;

  select full_name into v_actor_name from public.profiles where id = v_actor;

  for v_served in
    select q.id as request_id, q.requester_id
    from public.ride_requests rr join public.requests q on q.id = rr.request_id
    where rr.ride_id = p_ride_id and q.requester_id is distinct from v_actor
  loop
    perform public.enqueue_notification(v_served.requester_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
      jsonb_build_object('byName', coalesce(v_actor_name, '')),
      jsonb_build_object('variant', 'ride_cancelled', 'ride_id', p_ride_id, 'request_id', v_served.request_id),
      format('ride_cancelled:%s:%s:%s', p_ride_id, v_ride.version, v_served.request_id));
  end loop;

  -- Named ride_passengers (F3, 20260914120000): no `requests` row of their own, so they are
  -- never reached by the loop above — notify them the same way.
  for v_passenger in
    select rp.person_id
    from public.ride_passengers rp
    where rp.ride_id = p_ride_id and rp.person_id is not null and rp.person_id is distinct from v_actor
  loop
    perform public.enqueue_notification(v_passenger.person_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
      jsonb_build_object('byName', coalesce(v_actor_name, '')),
      jsonb_build_object('variant', 'ride_cancelled', 'ride_id', p_ride_id),
      format('ride_cancelled:%s:%s:%s', p_ride_id, v_ride.version, v_passenger.person_id));
  end loop;

  update public.requests set status = 'cancelled', status_reason = 'RIDE_CANCELLED'
  where id in (select request_id from public.ride_requests where ride_id = p_ride_id);

  if v_is_relay then
    -- Flag the partner leg for the Sadran instead of opening a freed-slot offer (REQ §13.63).
    update public.rides set status = 'flagged', flag_reason = 'relay_pair_cancelled'
    where car_id = v_ride.car_id and week_start = v_ride.week_start and status <> 'cancelled'
      and (origin_id = v_ride.destination_id or destination_id = v_ride.origin_id) and id <> p_ride_id;
    return;
  end if;

  if v_ride.origin_id = v_ride.destination_id then
    insert into public.freed_slot_offers (department_id, week_start, car_id, cancelled_ride_id, starts_at, ends_at, expires_at)
    values (v_ride.department_id, v_ride.week_start, v_ride.car_id, p_ride_id, v_ride.starts_at, v_ride.ends_at, v_ride.starts_at)
    returning id into v_offer_id;

    -- Notify the on-ride-cancelled edge function (pg_net) if configured; a no-op locally
    -- until app_settings.on_ride_cancelled_url is set, so this never breaks db reset/tests.
    perform net.http_post(
      url := cfg.url_val,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', coalesce(cfg.secret_val, '')),
      body := jsonb_build_object('offer_id', v_offer_id)
    )
    from (
      select
        (select value ->> 'value' from public.app_settings where key = 'on_ride_cancelled_url') as url_val,
        (select value ->> 'value' from public.app_secrets where key = 'cron_secret') as secret_val
    ) cfg
    where cfg.url_val is not null and cfg.url_val <> '';
  end if;
end;
$$;

revoke execute on function public.cancel_ride_without_passengers(uuid, text, int) from public, anon, authenticated;

-- v_board_rides: expose each ride's named passengers so "my rides" (Home, siddur) can include
-- a member named as a `ride_passengers.person_id`, same wrap-and-append idiom as
-- 20260910093900_series_columns_in_views.sql.
do $migration$
declare def text;
begin
  def := regexp_replace(pg_get_viewdef('public.v_board_rides'::regclass, true), ';\s*$', '');
  execute 'create or replace view public.v_board_rides with (security_invoker = true) as
    select existing.*,
      coalesce((select jsonb_agg(jsonb_build_object(
          ''id'', rp.id, ''person_id'', rp.person_id, ''child_id'', rp.child_id,
          ''display_name'', rp.display_name, ''seat_kind'', rp.seat_kind
        ) order by rp.created_at)
        from public.ride_passengers rp where rp.ride_id = existing.id), ''[]''::jsonb) as passengers
    from (' || def || ') existing';
end;
$migration$;

grant select on public.v_board_rides to authenticated;
revoke all on public.v_board_rides from anon;
