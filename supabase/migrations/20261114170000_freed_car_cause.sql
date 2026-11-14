-- FC1 (owner 2026-11-14, REQ item 231): a freed car names its cause, and any change that leaves time free on a shared
-- car on a published day offers it.
--   * freed_slot_offers records the cause: kind (cancel | shorten | edit), who made the change, whose ride it was, and
--     whether the ride is still there (a shortened or moved ride keeps the rest of its time).
--   * One check after the ride write: a row trigger keeps each published ride's state from before the first change in
--     the transaction; a deferred trigger compares it with the final state at commit and offers the freed hours of a
--     ride that is still there (shortened, moved, put on another car). Cancellations keep offering through
--     _offer_freed_slot, as before.
--   * "שובצת לרכב שהתפנה" now carries its car, day, hours and route (they were blank) and the cause in its title, and it
--     goes to everyone on the new ride (driver, requesters, companions, named passengers), one notice each. The
--     waiting-list discussion's "car freed" notices carry the cause too.
--   * freed_slot_candidates no longer skips the freed ride's own row when that ride is still there.

alter table public.freed_slot_offers
  add column cause_kind text,
  add column cause_actor uuid,
  add column cause_owner_id uuid,
  add column kept_ride boolean not null default false,
  add constraint freed_slot_offers_cause_kind_ck check (cause_kind is null or cause_kind in ('cancel', 'shorten', 'edit'));

comment on column public.freed_slot_offers.cause_kind is 'FC1: what freed the car — cancel (the ride is gone), shorten (fewer hours on the same car), edit (other hours or another car).';
comment on column public.freed_slot_offers.cause_actor is 'FC1: who made the change (null = a system step).';
comment on column public.freed_slot_offers.cause_owner_id is 'FC1: whose ride freed the car (its driver, else its first requester, else its first named passenger).';
comment on column public.freed_slot_offers.kept_ride is 'FC1: the freed ride is still there (shortened or moved): it still holds the rest of its time.';

insert into public.text_fragments (key, body) values
  ('freed_cause.cancel', 'הנסיעה של {{owner}} בוטלה'),
  ('freed_cause.shorten', 'הנסיעה של {{owner}} קוצרה'),
  ('freed_cause.edit', 'הנסיעה של {{owner}} שונתה'),
  ('freed_cause.cancel_anon', 'נסיעה בוטלה'),
  ('freed_cause.shorten_anon', 'נסיעה קוצרה'),
  ('freed_cause.edit_anon', 'נסיעה שונתה')
on conflict (key) do update set body = excluded.body, updated_at = now();

update public.notification_templates set title = 'שובצת לרכב שהתפנה{{causeNote}}', updated_at = now()
where event = 'freed_slot_auto' and coalesce(variant, '') = '';
update public.notification_templates set title = 'התפנה רכב לזמן שלכם{{causeNote}}', updated_at = now()
where event = 'waitlist_contested' and variant = 'car_freed';
update public.notification_templates set title = 'התפנה רכב לדיון{{causeNote}}', updated_at = now()
where event = 'waitlist_contested' and variant = 'car_freed_sadran';

-- Whose ride it is: its driver, else its first requester, else its first named passenger.
create or replace function public._ride_owner_id(p_ride_id uuid)
returns uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select r.driver_id from public.rides r where r.id = p_ride_id),
    (select q.requester_id from public.ride_requests rr join public.requests q on q.id = rr.request_id
     where rr.ride_id = p_ride_id order by (rr.role = 'driver') desc, rr.created_at, rr.request_id limit 1),
    (select rp.person_id from public.ride_passengers rp where rp.ride_id = p_ride_id and rp.person_id is not null
     order by rp.created_at, rp.id limit 1))
$$;

revoke all on function public._ride_owner_id(uuid) from public, anon, authenticated;

-- " (הנסיעה של דנה בוטלה)" for an offer that knows its cause, '' otherwise.
create or replace function public._freed_cause_note(p_offer_id uuid)
returns text
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select ' (' || public._frag('freed_cause.' || o.cause_kind || case when p.full_name is null then '_anon' else '' end,
                                jsonb_build_object('owner', coalesce(p.full_name, ''))) || ')'
    from public.freed_slot_offers o left join public.profiles p on p.id = o.cause_owner_id
    where o.id = p_offer_id and o.cause_kind is not null), '')
$$;

revoke all on function public._freed_cause_note(uuid) from public, anon, authenticated;

-- The car's free gap around [p_from, p_to] that day, offered once (REQ §13.102 b): previous ride end + turnaround
-- ... next ride start - turnaround; a neighbour that does not leave / expect the car at p_place bounds the gap at the
-- freed hours themselves; maintenance ends it. Nothing is offered when another ride or a maintenance period already
-- takes part of the freed hours, or when they are over. p_exclude is a ride the caller is cancelling right now.
create or replace function public._offer_freed_time(
  p_ride_id uuid, p_car_id uuid, p_from timestamptz, p_to timestamptz, p_place uuid,
  p_kind text, p_kept boolean, p_exclude uuid default null)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_ride public.rides%rowtype; v_offer_id uuid;
  v_ta interval; v_day_start timestamptz; v_day_end timestamptz;
  v_prev record; v_next record; v_gap_start timestamptz; v_gap_end timestamptz; v_maint timestamptz;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride.id is null or p_to <= p_from or p_to <= now() then return null; end if;
  -- REQ §13.99: nothing is ever offered from a private (temporary) car; only shared cars free a slot.
  if not exists (select 1 from public.cars c where c.id = p_car_id and c.type = 'shared') then return null; end if;
  if exists (select 1 from public.rides r where r.car_id = p_car_id and r.status <> 'cancelled' and not r.planning_conflict
             and r.id is distinct from p_exclude and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(p_from, p_to, '[)'))
     or exists (select 1 from public.car_maintenance_blocks b where b.car_id = p_car_id
                and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(p_from, p_to, '[)')) then
    return null;
  end if;

  v_ta := make_interval(mins => coalesce(public.required_turnaround_minutes(v_ride.department_id, v_ride.week_start), 30));
  v_day_start := ((p_from at time zone 'Asia/Jerusalem')::date)::timestamp at time zone 'Asia/Jerusalem';
  v_day_end := (((p_from at time zone 'Asia/Jerusalem')::date + 1)::timestamp at time zone 'Asia/Jerusalem') - interval '1 minute';
  select r.ends_at, r.destination_id into v_prev from public.rides r
  where r.car_id = p_car_id and r.status <> 'cancelled' and r.id is distinct from p_exclude and r.ends_at <= p_from
    and r.ends_at >= v_day_start and not r.planning_conflict
  order by r.ends_at desc limit 1;
  select r.starts_at, r.origin_id into v_next from public.rides r
  where r.car_id = p_car_id and r.status <> 'cancelled' and r.id is distinct from p_exclude and r.starts_at >= p_to
    and r.starts_at <= v_day_end and not r.planning_conflict
  order by r.starts_at limit 1;
  select min(b.starts_at) into v_maint from public.car_maintenance_blocks b
  where b.car_id = p_car_id and b.starts_at >= p_to and b.starts_at <= v_day_end;
  v_gap_start := case when v_prev.ends_at is null then v_day_start
                      when v_prev.destination_id is distinct from p_place then p_from
                      else least(v_prev.ends_at + v_ta, p_from) end;
  v_gap_end := case when v_next.starts_at is null then v_day_end
                    when v_next.origin_id is distinct from p_place then p_to
                    else greatest(v_next.starts_at - v_ta, p_to) end;
  if v_maint is not null then v_gap_end := greatest(least(v_gap_end, v_maint), p_to); end if;

  -- a ride shortened again while its earlier freed hours are still open: the newer offer replaces the open one
  update public.freed_slot_offers set status = 'closed', resolved_at = now(), close_reason = 'superseded'
  where cancelled_ride_id = p_ride_id and status = 'open' and kept_ride;
  insert into public.freed_slot_offers (department_id, week_start, car_id, cancelled_ride_id, starts_at, ends_at, expires_at,
    cause_kind, cause_actor, cause_owner_id, kept_ride)
  values (v_ride.department_id, v_ride.week_start, p_car_id, p_ride_id, v_gap_start, v_gap_end, greatest(p_from, now()),
    p_kind, (select auth.uid()), public._ride_owner_id(p_ride_id), p_kept)
  on conflict (cancelled_ride_id) where status in ('open', 'pending_approval') do nothing
  returning id into v_offer_id;
  if v_offer_id is null then return null; end if;

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
  return v_offer_id;
end;
$$;

revoke all on function public._offer_freed_time(uuid, uuid, timestamptz, timestamptz, uuid, text, boolean, uuid) from public, anon, authenticated;

-- A cancelled ride's hours (every caller has just cancelled it). A published edit that re-places the request
-- (submit_request sets app.edit_prefer_car) reads as "changed", anything else as "cancelled".
create or replace function public._offer_freed_slot(p_ride_id uuid)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_ride public.rides%rowtype;
begin
  select * into v_ride from public.rides where id = p_ride_id;
  if v_ride.id is null or v_ride.origin_id is distinct from v_ride.destination_id then return null; end if;
  return public._offer_freed_time(p_ride_id, v_ride.car_id, v_ride.starts_at, v_ride.ends_at, v_ride.origin_id,
    case when coalesce(current_setting('app.edit_prefer_car', true), '') <> '' then 'edit' else 'cancel' end,
    false, p_ride_id);
end;
$$;

revoke all on function public._offer_freed_slot(uuid) from public, anon, authenticated;

-- The one check after the ride write. Before the first change of a published round-trip ride on a shared car in this
-- transaction, its car and hours are kept (app.freed_before); at commit the deferred trigger offers what it gave up.
create or replace function public.rides_freed_time_keep()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_map jsonb := coalesce(nullif(current_setting('app.freed_before', true), ''), '{}')::jsonb;
begin
  if v_map ? old.id::text then return null; end if;
  perform set_config('app.freed_before', (v_map || jsonb_build_object(old.id::text, jsonb_build_object(
    'car', old.car_id, 'from', old.starts_at, 'to', old.ends_at, 'place', old.origin_id)))::text, true);
  return null;
end $$;

revoke all on function public.rides_freed_time_keep() from public, anon, authenticated;

create or replace function public.rides_freed_time_offer()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_map jsonb := coalesce(nullif(current_setting('app.freed_before', true), ''), '{}')::jsonb;
  b jsonb; r public.rides%rowtype; v_car uuid; v_from timestamptz; v_to timestamptz; v_kind text;
begin
  if not v_map ? new.id::text then return null; end if;
  b := v_map -> new.id::text;
  perform set_config('app.freed_before', (v_map - new.id::text)::text, true);
  select * into r from public.rides where id = new.id;
  -- a cancelled ride is offered by whoever cancelled it; a series or a relay leg is never offered (as on cancel)
  if r.id is null or r.status = 'cancelled' or r.series_id is not null or r.planning_conflict
     or r.origin_id is distinct from r.destination_id then return null; end if;
  v_car := (b ->> 'car')::uuid; v_from := (b ->> 'from')::timestamptz; v_to := (b ->> 'to')::timestamptz;
  if r.car_id is distinct from v_car then
    perform public._offer_freed_time(r.id, v_car, v_from, v_to, (b ->> 'place')::uuid, 'edit', true);
    return null;
  end if;
  v_kind := case when r.starts_at >= v_from and r.ends_at <= v_to then 'shorten' else 'edit' end;
  if r.starts_at > v_from then
    perform public._offer_freed_time(r.id, v_car, v_from, least(v_to, r.starts_at), (b ->> 'place')::uuid, v_kind, true);
  end if;
  if r.ends_at < v_to then
    perform public._offer_freed_time(r.id, v_car, greatest(v_from, r.ends_at), v_to, (b ->> 'place')::uuid, v_kind, true);
  end if;
  return null;
end $$;

revoke all on function public.rides_freed_time_offer() from public, anon, authenticated;

create trigger rides_freed_time_keep
  after update of car_id, starts_at, ends_at on public.rides
  for each row
  when (old.status in ('confirmed', 'flagged') and not old.planning_conflict and old.series_id is null
        and old.origin_id is not distinct from old.destination_id
        and (new.car_id is distinct from old.car_id or new.starts_at > old.starts_at or new.ends_at < old.ends_at))
  execute function public.rides_freed_time_keep();

create constraint trigger rides_freed_time_offer
  after update of car_id, starts_at, ends_at on public.rides
  deferrable initially deferred
  for each row
  when (old.status in ('confirmed', 'flagged') and not old.planning_conflict and old.series_id is null
        and old.origin_id is not distinct from old.destination_id
        and (new.car_id is distinct from old.car_id or new.starts_at > old.starts_at or new.ends_at < old.ends_at))
  execute function public.rides_freed_time_offer();

-- Candidates: as before, but a freed ride that is still there (kept_ride) still holds the rest of its time.
create or replace function public.freed_slot_candidates(_offer uuid)
returns table(request_id uuid, requester_id uuid, fits boolean, slack interval)
language sql stable security definer
set search_path = public, pg_temp
as $$
  with o as (
    select fo.*, cr.origin_id as cr_origin
    from freed_slot_offers fo join rides cr on cr.id = fo.cancelled_ride_id
    where fo.id = _offer and fo.status = 'open' and cr.origin_id = cr.destination_id
  ),
  pool as (
    -- the waiting list, as before (a plan B waiting for its driver is read with its main trip below)
    -- REQ §13.193: a one-leg הקפצה (drop-off only or pickup only) is read as its chauffeur ride at its own time
    select q.id, q.requester_id, q.adults, q.child_seats, q.boosters, q.has_luggage, q.needs_tow_hitch, q.luggage_waived_at,
      case when q.trip_type = 'drop_off' and q.depart_at is null
           then q.return_at - make_interval(mins => public.chauffeur_ride_minutes(q.id, 'return'))
           else q.depart_at end as dep,
      case when q.trip_type = 'drop_off' and q.return_at is null
           then q.depart_at + make_interval(mins => public.chauffeur_ride_minutes(q.id, 'out'))
           else q.return_at end as ret,
      q.origin_id, q.origin_text, q.submitted_at
    from o join requests q
      on q.department_id = o.department_id and q.week_start = o.week_start
     and q.status in ('waitlisted','denied','external') and not q.served_by_alternative
     and (q.trip_shape = 'round_trip' or q.trip_type = 'drop_off')   -- one-way requests are never auto-placed (REQ §13.64); a הקפצה is (§13.193)
     and q.series_id is null                             -- REQ §13.77: a multi-day series never fits a one-day freed slot
     -- R2B3: a request that already holds one leg is only a candidate for a הקפצה (the missing leg is placed alone)
     and (q.trip_type = 'drop_off' or cardinality(public.request_covered_legs(q.id)) = 0)
    where not q.freed_slot_opt_out
    union all
    -- REQ §13.168: served by its plan B; its main trip is a round trip
    select q.id, q.requester_id, q.adults, q.child_seats, q.boosters, q.has_luggage, q.needs_tow_hitch, q.luggage_waived_at,
      (a.original_main ->> 'depart_at')::timestamptz, (a.original_main ->> 'return_at')::timestamptz,
      q.origin_id, q.origin_text, q.submitted_at
    from o join requests q
      on q.department_id = o.department_id and q.week_start = o.week_start
     -- any live plan B: placed, riding with someone, or its chauffeur ride still waiting for a driver
     and q.status in ('assigned', 'merged', 'waitlisted') and q.served_by_alternative and q.series_id is null and q.plan_b_parent_id is null
    join request_alternatives a on a.request_id = q.id and a.original_main is not null
    where not q.freed_slot_opt_out and a.original_main ->> 'trip_type' = 'round_trip'
      and a.original_main ->> 'depart_at' is not null and a.original_main ->> 'return_at' is not null
  )
  select p.id, p.requester_id,
         public.car_fits(o.car_id, p.adults, p.child_seats, p.boosters) as fits,
         (o.ends_at - o.starts_at) - (p.ret - p.dep) as slack
  from o join pool p on true
  -- REQ §13.102 (b): the request's own times lie inside the car's free gap, and it starts where the car is
  where p.dep >= o.starts_at and p.ret <= o.ends_at
    and (p.origin_id = o.cr_origin or (p.origin_id is null and p.origin_text is null))
    and not exists (select 1 from rides r2 where r2.car_id = o.car_id and r2.status <> 'cancelled' and not r2.draft_hold
         and (o.kept_ride or r2.id <> o.cancelled_ride_id) and not r2.planning_conflict
         -- a plan-B request's own plan-B rides are released when it takes the car
         and not exists (select 1 from ride_requests rr where rr.ride_id = r2.id
                          and (rr.request_id = p.id or rr.request_id in (select x.id from requests x where x.plan_b_parent_id = p.id)))
         and tstzrange(r2.starts_at, r2.blocked_until, '[)') && tstzrange(p.dep, p.ret, '[)'))
    -- REQ §13.114: a scheduled maintenance period on the freed car (also one added after the offer was
    -- made) is never offered, incl. the turnaround buffer before it.
    and not exists (select 1 from car_maintenance_blocks b where b.car_id = o.car_id
         and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(p.dep,
           p.ret + make_interval(mins => coalesce(public.required_turnaround_minutes(o.department_id, o.week_start), 30)), '[)'))
    -- RC1B3: the people a Sadran cancelled this ride on and kept on the waiting list are not offered its own car
    and p.id <> all(o.excluded_request_ids)
    and public.car_fits(o.car_id, p.adults, p.child_seats, p.boosters)
    and public.car_meets_needs(o.car_id, case when p.has_luggage and p.luggage_waived_at is null then 1 else 0 end, case when p.needs_tow_hitch and p.luggage_waived_at is null then 1 else 0 end)
  order by slack asc, p.submitted_at asc;
$$;

revoke all on function public.freed_slot_candidates(uuid) from public, anon, authenticated;
grant execute on function public.freed_slot_candidates(uuid) to service_role;

create or replace function public.resolve_freed_offer(p_offer_id uuid, p_ranked_candidates jsonb, p_options jsonb default '[]'::jsonb)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_offer record;
  v_count int;
  v_first jsonb;
  v_ride_id uuid;
  v_cand jsonb;
  v_req uuid; v_to uuid; v_cars text; v_main jsonb; v_q public.requests%rowtype; v_vars jsonb; v_notif uuid;
  v_group uuid; v_g record; m record; v_car_name text;
  v_prio uuid[]; v_ok jsonb := '[]'::jsonb; v_ok_ids uuid[]; v_plan_b int; v_options jsonb; v_rec text;
  v_cause text := public._freed_cause_note(p_offer_id); v_ride public.rides%rowtype; v_person uuid;
begin
  select * into v_offer from public.freed_slot_offers where id = p_offer_id;
  if v_offer is null then raise exception 'offer_not_found' using errcode = 'P0001'; end if;
  if v_offer.status <> 'open' then raise exception 'offer_not_open' using errcode = 'P0001'; end if;

  -- R12B3 (REQ §13.119): a candidate the freed car cannot really take (the car is not at the leg's place, a turnaround...)
  -- is dropped here, so the lone-candidate placement below cannot fail with car_not_at_leg_place.
  for v_cand in select * from jsonb_array_elements(coalesce(p_ranked_candidates, '[]')) loop
    -- R17B5: someone who stepped out of this car stays out when it is ranked again (a group closing, a refresh).
    if not exists (select 1 from public.freed_slot_claims x where x.offer_id = p_offer_id
                   and x.request_id = (v_cand ->> 'request_id')::uuid and x.status = 'withdrawn')
       and public.freed_candidate_placeable(p_offer_id, (v_cand ->> 'request_id')::uuid) then v_ok := v_ok || jsonb_build_array(v_cand); end if;
  end loop;
  p_ranked_candidates := v_ok;
  v_count := jsonb_array_length(p_ranked_candidates);
  -- REQ §13.168: the options (one request, or several one after another) keep only placeable candidates.
  select coalesce(array_agg((c ->> 'request_id')::uuid), '{}') into v_ok_ids from jsonb_array_elements(p_ranked_candidates) c;
  -- the best remaining option is the recommendation (the edge function's first one may have been dropped)
  select coalesce(jsonb_agg(o || jsonb_build_object('recommended', rn = 1) order by rn), '[]'::jsonb) into v_options
  from (select o, row_number() over (order by n) as rn
        from jsonb_array_elements(coalesce(p_options, '[]'::jsonb)) with ordinality x(o, n)
        where not exists (select 1 from jsonb_array_elements_text(o -> 'request_ids') rid where rid::uuid <> all(v_ok_ids))) kept;
  select count(*) into v_plan_b from public.requests q where q.id = any(v_ok_ids) and q.served_by_alternative;
  perform set_config('app.audit_reason', 'resolve_freed_offer', true);

  -- REQ §13.101 (i): the open contested group whose time this car frees goes first.
  v_group := public.freed_offer_group(p_offer_id);
  if v_group is not null and v_count > 0 then
    select coalesce(array_agg(wm.request_id), '{}') into v_prio from public.waitlist_group_members wm
    where wm.group_id = v_group and wm.chosen is null
      and wm.request_id in (select (c ->> 'request_id')::uuid from jsonb_array_elements(p_ranked_candidates) c);
    if cardinality(v_prio) > 0 then
      select * into v_g from public.waitlist_groups where id = v_group;
      select name into v_car_name from public.cars where id = v_offer.car_id;
      update public.freed_slot_offers set group_id = v_group where id = p_offer_id;
      for m in select wm.request_id, wm.profile_id from public.waitlist_group_members wm
               where wm.group_id = v_group and wm.chosen is null order by wm.created_at, wm.id loop
        perform public.enqueue_notification(m.profile_id, 'waitlist_contested', v_g.department_id, v_g.week_start,
          jsonb_build_object('car', coalesce(v_car_name, ''), 'day', public.day_date_label(v_g.starts_at),
            'depart', to_char(v_g.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI'),
            'return', to_char(v_g.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI'), 'causeNote', v_cause),
          jsonb_build_object('group_id', v_group, 'request_id', m.request_id, 'day', v_g.day::text, 'variant', 'car_freed'),
          format('waitlist_car_freed:%s:%s:%s', v_group, p_offer_id, m.profile_id));
      end loop;
      perform public.enqueue_notification(s.profile_id, 'waitlist_contested', v_g.department_id, v_g.week_start,
        jsonb_build_object('car', coalesce(v_car_name, ''), 'day', public.day_date_label(v_g.starts_at),
          'depart', to_char(v_g.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI'),
          'return', to_char(v_g.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI'), 'causeNote', v_cause),
        jsonb_build_object('group_id', v_group, 'day', v_g.day::text, 'variant', 'car_freed_sadran'),
        format('waitlist_car_freed:%s:%s:sadran:%s', v_group, p_offer_id, s.profile_id))
      from public.sadranim_of(v_g.department_id, v_g.week_start) as s(profile_id);
      return;
    end if;
  end if;

  if v_count = 0 then
    update public.freed_slot_offers set status = 'closed', resolved_at = now() where id = p_offer_id;
  elsif v_count = 1 and v_plan_b = 0 then
    -- REQ §13.168 (b): obvious — one waiting-list candidate (a lone plan-B candidate still goes to the Sadran:
    -- it trades a plan B that works).
    v_first := p_ranked_candidates -> 0;
    begin
      v_ride_id := public.place_freed_slot_request(p_offer_id, (v_first ->> 'request_id')::uuid, null, 'FREED_SLOT_AUTO');
    exception when others then
      -- never silently stuck: close the offer with the reason and tell the Sadran
      perform public.fail_freed_offer(p_offer_id, sqlerrm);
      return;
    end;

    update public.freed_slot_offers set status = 'auto_assigned', resolved_at = now(),
      winning_request_id = (v_first ->> 'request_id')::uuid
    where id = p_offer_id;

    -- FC1: the car, day, hours and route of the new ride, and the cause, to everyone on it — one notice each.
    select * into v_ride from public.rides where id = v_ride_id;
    v_vars := jsonb_build_object(
      'car', coalesce((select name from public.cars where id = v_offer.car_id), ''),
      'day', coalesce(public.day_date_label(v_ride.starts_at), ''),
      'timeRange', coalesce(public._window_text(v_ride.starts_at, v_ride.ends_at), ''),
      'route', coalesce(public.request_route_label((v_first ->> 'request_id')::uuid), ''),
      'causeNote', v_cause);
    for v_person in
      select x.pid from (
        select (v_first ->> 'requester_id')::uuid as pid
        union select v_ride.driver_id
        union select q.requester_id from public.ride_requests rr join public.requests q on q.id = rr.request_id where rr.ride_id = v_ride_id
        union select rc.profile_id from public.ride_requests rr join public.request_companions rc on rc.request_id = rr.request_id
              where rr.ride_id = v_ride_id
        union select rp.person_id from public.ride_passengers rp where rp.ride_id = v_ride_id) x
      where x.pid is not null order by x.pid
    loop
      perform public.enqueue_notification(v_person, 'freed_slot_auto', v_offer.department_id, v_offer.week_start,
        v_vars, jsonb_build_object('ride_id', v_ride_id, 'request_id', (v_first ->> 'request_id')::uuid),
        format('freed_slot_auto:%s:%s', p_offer_id, v_person));
    end loop;
  else
    for v_cand in select * from jsonb_array_elements(p_ranked_candidates) loop
      v_req := (v_cand ->> 'request_id')::uuid;
      v_to := (v_cand ->> 'requester_id')::uuid;
      -- ranked again (R17B5): a candidate already told about this car is not told again
      continue when exists (select 1 from public.freed_slot_claims x where x.offer_id = p_offer_id and x.request_id = v_req);
      insert into public.freed_slot_claims (offer_id, request_id, profile_id, status, offered_at)
      values (p_offer_id, v_req, v_to, 'offered', now());
      -- R17B4 (QA run 17): one notice per request, not one per freed car — an unread "the Sadran decides" notice of
      -- the same request is folded into this one, which names every car still being decided for it.
      select string_agg(distinct c.name, ' / ') into v_cars
      from public.freed_slot_claims fc join public.freed_slot_offers o on o.id = fc.offer_id join public.cars c on c.id = o.car_id
      where fc.request_id = v_req and fc.status = 'offered' and (o.id = p_offer_id or o.status in ('open', 'pending_approval'));
      delete from public.notifications
      where recipient_id = v_to and event = 'freed_slot' and read_at is null
        and data ->> 'request_id' = v_req::text and data ->> 'variant' = 'sadran_deciding';
      -- R17B3: a request served by its plan B reads its main trip (route, day, hours), not the plan B's.
      select a.original_main into v_main from public.request_alternatives a
      where a.request_id = v_req and a.applied_at is not null and a.original_main is not null;
      select * into v_q from public.requests where id = v_req;
      v_vars := jsonb_build_object('car', coalesce(v_cars, (select name from public.cars where id = v_offer.car_id), ''));
      if v_main is not null and v_q.served_by_alternative then
        v_vars := v_vars || jsonb_build_object(
          'route', coalesce(public.route_label(v_q.department_id, v_q.origin_id, v_q.origin_text,
            nullif(v_main ->> 'destination_id', '')::uuid, v_main ->> 'destination_text'), ''),
          'day', public.day_date_label((v_main ->> 'depart_at')::timestamptz),
          'timeRange', public._window_text((v_main ->> 'depart_at')::timestamptz, nullif(v_main ->> 'return_at', '')::timestamptz));
      end if;
      v_notif := public.enqueue_notification(v_to, 'freed_slot', v_offer.department_id, v_offer.week_start, v_vars,
        jsonb_build_object('offer_id', p_offer_id, 'request_id', v_req, 'variant', 'sadran_deciding'),
        format('freed_slot:%s:%s:%s', p_offer_id, v_req, clock_timestamp()));
      if v_notif is not null then
        update public.push_outbox set payload = payload || jsonb_build_object('tag', format('replace:freed_slot:%s', v_req))
        where notification_id = v_notif;
      end if;
    end loop;
    -- REQ §13.168 (c): no single obvious choice — the Sadran decides from the ranked options.
    if jsonb_array_length(v_options) = 0 then
      select coalesce(jsonb_agg(jsonb_build_object('request_ids', jsonb_build_array(c ->> 'request_id'), 'score', 0,
        'unused_minutes', 0, 'plan_b', 0, 'recommended', n = 1) order by n), '[]'::jsonb)
      into v_options from jsonb_array_elements(p_ranked_candidates) with ordinality x(c, n);
    end if;
    select string_agg(coalesce(p.full_name, ''), ' + ' order by rid.n) into v_rec
    from jsonb_array_elements_text((select o -> 'request_ids' from jsonb_array_elements(v_options) o where (o ->> 'recommended')::boolean limit 1)) with ordinality rid(id, n)
    join public.requests q on q.id = rid.id::uuid join public.profiles p on p.id = q.requester_id;
    update public.freed_slot_offers set status = 'pending_approval', options = v_options where id = p_offer_id;
    perform public.enqueue_notification(s.profile_id, 'claim_contested', v_offer.department_id, v_offer.week_start,
      jsonb_build_object('count', jsonb_array_length(v_options)::text, 'recommended', coalesce(v_rec, ''),
        'car', coalesce((select name from public.cars where id = v_offer.car_id), ''),
        'day', public.day_date_label(v_offer.starts_at),
        'timeRange', to_char(v_offer.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI') || '–' || to_char(v_offer.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI')),
      jsonb_build_object('offer_id', p_offer_id, 'variant', 'options'), format('claim_contested:%s', p_offer_id))
    from public.sadranim_of(v_offer.department_id, v_offer.week_start) as s(profile_id);
  end if;
end;
$$;

revoke all on function public.resolve_freed_offer(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.resolve_freed_offer(uuid, jsonb, jsonb) to service_role;

-- A ride that is deleted (an undone insert, a re-solve) takes the offers of its freed hours with it: an offer of a
-- kept ride must never block the delete (an offer of a cancelled ride is unchanged — cancelled rides are kept).
create or replace function public.rides_drop_kept_freed_offers()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.freed_slot_offers where cancelled_ride_id = old.id and kept_ride;
  return old;
end $$;

revoke all on function public.rides_drop_kept_freed_offers() from public, anon, authenticated;

create trigger rides_drop_kept_freed_offers
  before delete on public.rides
  for each row execute function public.rides_drop_kept_freed_offers();
