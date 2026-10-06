-- REQ §13.102 (b), R2B3, R2B6, R2B18: freed cars are offered for their whole free gap; the freed-slot
-- placement places only the legs a request is missing (no duplicate out leg); a removed ride that moved
-- the car flags the later rides that now start where the car is not (Sadran notice).


create or replace function public.request_covered_legs(p_request_id uuid) returns text[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct x.leg) filter (where x.leg is not null), '{}'::text[]) from (
    select 'out' as leg from public.ride_requests rr join public.rides r on r.id = rr.ride_id
      where rr.request_id = p_request_id and rr.covers_out and r.status not in ('cancelled', 'draft')
    union all
    select 'return' from public.ride_requests rr join public.rides r on r.id = rr.ride_id
      where rr.request_id = p_request_id and rr.covers_return and r.status not in ('cancelled', 'draft')
  ) x;
$$;
revoke all on function public.request_covered_legs(uuid) from public, anon;

create or replace function public.flag_car_chain_breaks(p_car uuid, p_week date) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; v_expected uuid; v_n int := 0; v_dept uuid;
begin
  select department_id into v_dept from public.cars where id = p_car;
  if v_dept is null then return 0; end if;
  for r in
    select rd.* from public.rides rd
    where rd.car_id = p_car and rd.week_start = p_week and rd.status <> 'cancelled' and not rd.planning_conflict
      and (not rd.auto_relocation or rd.driver_id is not null) and not public.ride_is_reservation(rd.id)
    order by rd.starts_at, rd.id
  loop
    v_expected := public.car_location_excluding(p_car, r.starts_at, r.id);
    if v_expected is distinct from r.origin_id then
      if r.flag_reason is distinct from 'car_chain_broken' and r.flag_reason is null then
        update public.rides set flag_reason = 'car_chain_broken',
          status = case when status = 'draft' then 'draft'::public.ride_status else 'flagged'::public.ride_status end
        where id = r.id;
        v_n := v_n + 1;
        perform public.enqueue_notification(s.profile_id, 'outcome_changed', r.department_id, r.week_start,
          '{}'::jsonb, jsonb_build_object('variant', 'car_chain_broken', 'ride_id', r.id, 'day', (r.starts_at at time zone 'Asia/Jerusalem')::date::text),
          format('car_chain_broken:%s:%s:%s', r.id, r.version, s.profile_id))
        from public.sadranim_of(r.department_id, r.week_start) as s(profile_id);
      end if;
    elsif r.flag_reason = 'car_chain_broken' then
      update public.rides set flag_reason = null,
        status = case when status = 'flagged' then 'confirmed'::public.ride_status else status end where id = r.id;
    end if;
  end loop;
  return v_n;
end $$;
revoke all on function public.flag_car_chain_breaks(uuid, date) from public, anon;

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'outcome_changed', ch, t.variant, t.title, t.body, t.title, t.body
from (values
  ('car_chain_broken', 'הרכב לא נמצא איפה שהנסיעה מתחילה', '{{car}} · {{day}} {{depart}} — נסיעה קודמת של הרכב הוסרה והרכב נשאר במקום אחר. כדאי לבדוק את הסידור.')
) as t(variant, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do update
  set title = excluded.title, body = excluded.body, default_title = excluded.default_title, default_body = excluded.default_body;

CREATE OR REPLACE FUNCTION public.cancel_ride_without_passengers(p_ride_id uuid, p_reason text, p_expected_version integer DEFAULT NULL::integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_ride record;
  v_is_relay boolean;
  v_offer_id uuid;
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_served record;
  v_passenger record;
  v_ta interval; v_day_start timestamptz; v_day_end timestamptz;
  v_prev record; v_next record; v_gap_start timestamptz; v_gap_end timestamptz; v_maint timestamptz;
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

  -- REQ §13.89: heal the chain of the car this ride just vacated, reusing its own
  -- origin/destination/times as the hint for whichever gap its removal opened up.
  perform set_config('app.chain_hint', jsonb_build_object('origin_id',v_ride.origin_id,'destination_id',v_ride.destination_id,
    'starts_at',v_ride.starts_at,'ends_at',v_ride.ends_at)::text, true);
  perform public.assert_car_chain(v_ride.car_id, v_ride.week_start);
  -- R2B6: whatever the removal left starting where the car is not gets flagged for the Sadran.
  perform public.flag_car_chain_breaks(v_ride.car_id, v_ride.week_start);

  if v_is_relay then
    -- Still flag the partner leg for the Sadran's attention (REQ §13.63) — the chain
    -- itself is already healed by the assert_car_chain call above.
    update public.rides set status = 'flagged', flag_reason = 'relay_pair_cancelled'
    where car_id = v_ride.car_id and week_start = v_ride.week_start and status <> 'cancelled'
      and (origin_id = v_ride.destination_id or destination_id = v_ride.origin_id) and id <> p_ride_id
      and not public.ride_is_reservation(id);
    return;
  end if;

  -- REQ §13.99: nothing is ever offered from a private (temporary) car; only shared cars free a slot.
  if v_ride.origin_id = v_ride.destination_id
     and exists (select 1 from public.cars c where c.id = v_ride.car_id and c.type = 'shared') then
    -- REQ §13.102 (b): the offer covers the car's whole free gap that day (previous ride end + turnaround
    -- ... next ride start - turnaround), not only the cancelled ride's own hours. A neighbour that does not
    -- leave/expect the car at this ride's place bounds the gap at the cancelled ride itself.
    v_ta := make_interval(mins => coalesce(public.required_turnaround_minutes(v_ride.department_id, v_ride.week_start), 30));
    v_day_start := ((v_ride.starts_at at time zone 'Asia/Jerusalem')::date)::timestamp at time zone 'Asia/Jerusalem';
    v_day_end := (((v_ride.starts_at at time zone 'Asia/Jerusalem')::date + 1)::timestamp at time zone 'Asia/Jerusalem') - interval '1 minute';
    select r.ends_at, r.destination_id into v_prev from public.rides r
    where r.car_id = v_ride.car_id and r.status <> 'cancelled' and r.id <> p_ride_id and r.ends_at <= v_ride.starts_at
      and r.ends_at >= v_day_start and not r.planning_conflict
    order by r.ends_at desc limit 1;
    select r.starts_at, r.origin_id into v_next from public.rides r
    where r.car_id = v_ride.car_id and r.status <> 'cancelled' and r.id <> p_ride_id and r.starts_at >= v_ride.ends_at
      and r.starts_at <= v_day_end and not r.planning_conflict
    order by r.starts_at limit 1;
    select min(b.starts_at) into v_maint from public.car_maintenance_blocks b
    where b.car_id = v_ride.car_id and b.starts_at >= v_ride.ends_at and b.starts_at <= v_day_end;
    v_gap_start := case when v_prev.ends_at is null then v_day_start
                        when v_prev.destination_id is distinct from v_ride.origin_id then v_ride.starts_at
                        else least(v_prev.ends_at + v_ta, v_ride.starts_at) end;
    v_gap_end := case when v_next.starts_at is null then v_day_end
                      when v_next.origin_id is distinct from v_ride.destination_id then v_ride.ends_at
                      else greatest(v_next.starts_at - v_ta, v_ride.ends_at) end;
    if v_maint is not null then v_gap_end := greatest(least(v_gap_end, v_maint), v_ride.ends_at); end if;
    insert into public.freed_slot_offers (department_id, week_start, car_id, cancelled_ride_id, starts_at, ends_at, expires_at)
    values (v_ride.department_id, v_ride.week_start, v_ride.car_id, p_ride_id, v_gap_start, v_gap_end, v_ride.starts_at)
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



create or replace function public.freed_slot_candidates(_offer uuid) returns table(request_id uuid, requester_id uuid, fits boolean, slack interval)
language sql stable security definer set search_path = public, pg_temp as $$
  select q.id, q.requester_id,
         public.car_fits(o.car_id, q.adults, q.child_seats, q.boosters) as fits,
         (o.ends_at - o.starts_at) - (q.return_at - q.depart_at) as slack
  from freed_slot_offers o
  join rides cr on cr.id = o.cancelled_ride_id
  join requests q
    on q.department_id = o.department_id and q.week_start = o.week_start
   and q.status in ('waitlisted','denied','external')
   and not q.freed_slot_opt_out
   and q.trip_shape = 'round_trip'                     -- one-way requests are never auto-placed (REQ §13.64)
   and q.series_id is null                             -- REQ §13.77: a multi-day series never fits a one-day freed slot
   -- R2B3: a request that already holds one leg is only a candidate for a הקפצה (the missing leg is placed alone)
   and (q.trip_type = 'drop_off' or cardinality(public.request_covered_legs(q.id)) = 0)
   -- REQ §13.102 (b): the request's own times lie inside the car's free gap, and it starts where the car is
   and q.depart_at >= o.starts_at and q.return_at <= o.ends_at
   and (q.origin_id = cr.origin_id or (q.origin_id is null and q.origin_text is null))
   and not exists (select 1 from rides r2 where r2.car_id = o.car_id and r2.status <> 'cancelled'
        and r2.id <> o.cancelled_ride_id and not r2.planning_conflict
        and tstzrange(r2.starts_at, r2.blocked_until, '[)') && tstzrange(q.depart_at, q.return_at, '[)'))
  where o.id = _offer and o.status = 'open'
    and cr.origin_id = cr.destination_id
    and public.car_fits(o.car_id, q.adults, q.child_seats, q.boosters)
    and public.car_takes_luggage(o.car_id, case when q.has_luggage then 1 else 0 end)
  order by slack asc, q.submitted_at asc;
$$;

create or replace function public.place_freed_slot_request(p_offer_id uuid, p_request_id uuid, p_actor uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_offer public.freed_slot_offers%rowtype; q public.requests%rowtype; v_ride uuid; v_covered text[]; v_prev text;
begin
  select * into v_offer from public.freed_slot_offers where id = p_offer_id;
  select * into q from public.requests where id = p_request_id for update;
  if v_offer.id is null or q.id is null then raise exception 'offer_not_found' using errcode = 'P0001'; end if;
  v_covered := public.request_covered_legs(p_request_id);
  v_prev := coalesce(current_setting('app.system_status_transition', true), 'off');
  perform set_config('app.system_status_transition', 'on', true);
  if q.trip_type = 'drop_off' then
    -- chauffeur legs on the freed car; legs a ride already serves are left alone (R2B3)
    perform set_config('app.place_only_missing', 'on', true);
    v_ride := public.place_request_on_car(p_request_id, v_offer.car_id, true, p_actor, null, null, null, p_reason);
    perform set_config('app.place_only_missing', 'off', true);
  elsif cardinality(v_covered) > 0 then
    raise exception 'freed_slot_not_applicable' using errcode = 'P0001';
  else
    insert into public.rides (department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id,
      driver_id, status, is_pinned, pin_reason, created_by)
    select r.department_id, r.week_start, v_offer.car_id, q.depart_at, q.return_at, r.origin_id, r.destination_id,
      q.requester_id, 'confirmed', true, p_reason, coalesce(p_actor, q.requester_id)
    from public.rides r where r.id = v_offer.cancelled_ride_id
    returning id into v_ride;
    insert into public.ride_requests (ride_id, request_id, role, leg, car_mode)
    values (v_ride, p_request_id, 'driver', 'both', 'keep');
    perform public.assert_car_chain(v_offer.car_id, v_offer.week_start);
    update public.requests set status = 'assigned', status_reason = p_reason where id = p_request_id;
  end if;
  perform set_config('app.system_status_transition', v_prev, true);
  return v_ride;
end $$;
revoke all on function public.place_freed_slot_request(uuid, uuid, uuid, text) from public, anon;

CREATE OR REPLACE FUNCTION public.resolve_freed_offer(p_offer_id uuid, p_ranked_candidates jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_offer record;
  v_count int;
  v_first jsonb;
  v_ride_id uuid;
  v_cand jsonb;
  v_group uuid; v_g record; m record; v_car_name text;
  v_prio uuid[];
begin
  select * into v_offer from public.freed_slot_offers where id = p_offer_id;
  if v_offer is null then raise exception 'offer_not_found' using errcode = 'P0001'; end if;
  if v_offer.status <> 'open' then raise exception 'offer_not_open' using errcode = 'P0001'; end if;

  v_count := jsonb_array_length(coalesce(p_ranked_candidates, '[]'));
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
            'return', to_char(v_g.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI')),
          jsonb_build_object('group_id', v_group, 'request_id', m.request_id, 'day', v_g.day::text, 'variant', 'car_freed'),
          format('waitlist_car_freed:%s:%s:%s', v_group, p_offer_id, m.profile_id));
      end loop;
      perform public.enqueue_notification(s.profile_id, 'waitlist_contested', v_g.department_id, v_g.week_start,
        jsonb_build_object('car', coalesce(v_car_name, ''), 'day', public.day_date_label(v_g.starts_at),
          'depart', to_char(v_g.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI'),
          'return', to_char(v_g.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI')),
        jsonb_build_object('group_id', v_group, 'day', v_g.day::text, 'variant', 'car_freed_sadran'),
        format('waitlist_car_freed:%s:%s:sadran:%s', v_group, p_offer_id, s.profile_id))
      from public.sadranim_of(v_g.department_id, v_g.week_start) as s(profile_id);
      return;
    end if;
  end if;

  if v_count = 0 then
    update public.freed_slot_offers set status = 'closed', resolved_at = now() where id = p_offer_id;
  elsif v_count = 1 then
    v_first := p_ranked_candidates -> 0;
    v_ride_id := public.place_freed_slot_request(p_offer_id, (v_first ->> 'request_id')::uuid, null, 'FREED_SLOT_AUTO');

    update public.freed_slot_offers set status = 'auto_assigned', resolved_at = now(),
      winning_request_id = (v_first ->> 'request_id')::uuid
    where id = p_offer_id;

    perform public.enqueue_notification((v_first ->> 'requester_id')::uuid, 'freed_slot_auto', v_offer.department_id, v_offer.week_start,
      '{}'::jsonb, jsonb_build_object('ride_id', v_ride_id), format('freed_slot_auto:%s', p_offer_id));
  else
    for v_cand in select * from jsonb_array_elements(p_ranked_candidates) loop
      insert into public.freed_slot_claims (offer_id, request_id, profile_id, status, offered_at)
      values (p_offer_id, (v_cand ->> 'request_id')::uuid, (v_cand ->> 'requester_id')::uuid, 'offered', now())
      on conflict (offer_id, request_id) do nothing;
      perform public.enqueue_notification((v_cand ->> 'requester_id')::uuid, 'freed_slot', v_offer.department_id, v_offer.week_start,
        '{}'::jsonb, jsonb_build_object('offer_id', p_offer_id),
        format('freed_slot:%s:%s', p_offer_id, v_cand ->> 'request_id'));
    end loop;
    update public.freed_slot_offers set status = 'pending_approval' where id = p_offer_id;
    perform public.enqueue_notification(s.profile_id, 'claim_contested', v_offer.department_id, v_offer.week_start,
      jsonb_build_object('count', v_count::text), jsonb_build_object('offer_id', p_offer_id), format('claim_contested:%s', p_offer_id))
    from public.sadranim_of(v_offer.department_id, v_offer.week_start) as s(profile_id);
  end if;
end;
$$;


CREATE OR REPLACE FUNCTION public.approve_claim(p_offer_id uuid, p_request_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare v_offer record; v_ride_id uuid;
begin
  select * into v_offer from public.freed_slot_offers where id = p_offer_id;
  if v_offer is null then raise exception 'offer_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_offer.department_id, v_offer.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'approve_claim', true);

  v_ride_id := public.place_freed_slot_request(p_offer_id, p_request_id, (select auth.uid()), 'FREED_SLOT_APPROVED');

  update public.freed_slot_claims set status = 'approved', decided_at = now(), decided_by = (select auth.uid())
  where offer_id = p_offer_id and request_id = p_request_id;
  update public.freed_slot_claims set status = 'declined', decided_at = now(), decided_by = (select auth.uid())
  where offer_id = p_offer_id and request_id <> p_request_id and status in ('offered', 'claimed');
  update public.freed_slot_offers set status = 'approved', resolved_at = now(), resolved_by = (select auth.uid()),
    winning_request_id = p_request_id where id = p_offer_id;

  perform public.enqueue_notification(q.requester_id, 'claim_approved', v_offer.department_id, v_offer.week_start,
    '{}'::jsonb, jsonb_build_object('ride_id', v_ride_id), format('claim_approved:%s', p_request_id))
  from public.requests q where q.id = p_request_id;
  perform public.enqueue_notification(fc.profile_id, 'claim_declined', v_offer.department_id, v_offer.week_start,
    '{}'::jsonb, jsonb_build_object('offer_id', p_offer_id), format('claim_declined:%s:%s', p_offer_id, fc.profile_id))
  from public.freed_slot_claims fc where fc.offer_id = p_offer_id and fc.request_id <> p_request_id and fc.status = 'declined';

  return v_ride_id;
end;
$$;


CREATE OR REPLACE FUNCTION public.place_request_on_car(p_request_id uuid, p_car_id uuid, p_manual boolean, p_actor uuid, p_named_driver uuid, p_dep timestamp with time zone, p_ret timestamp with time zone, p_reason text DEFAULT 'PROPOSAL_APPLIED'::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  q public.requests%rowtype; v_home uuid;
  v_car uuid; v_dep timestamptz; v_ret timestamptz; v_manual boolean; v_public boolean;
  v_named uuid; v_driver uuid; v_old record; v_old_cars uuid[] := '{}'; v_old_car uuid;
  v_ride uuid; v_first uuid; v_rides uuid[] := '{}'; v_end timestamptz;
  v_travel int; v_dur int; v_dwell int; v_gap smallint; v_buffer int;
  v_week_from timestamptz; v_week_until timestamptz; v_day date;
  v_leg public.ride_leg; v_at timestamptz; v_legs int := 0; v_wanted int := 0;
  v_s timestamptz; v_e timestamptz; v_loc uuid; v_ok boolean; k int; c int; v_rid uuid;
begin
  select * into q from public.requests where id = p_request_id for update;
  if q.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  v_car := p_car_id;
  if not exists(select 1 from public.cars where id = v_car and department_id = q.department_id and status = 'active') then
    raise exception 'shift_car_invalid' using errcode = 'P0001';
  end if;
  -- REQ §13.99: only the owner puts requests on a private car (the owner's own request on it is fine).
  perform public.assert_private_car_owner_only(v_car, p_actor, q.requester_id);
  v_manual := coalesce(p_manual, false);
  v_public := public.is_week_public(q.department_id, q.week_start);
  v_dep := case when q.trip_shape = 'one_way_from' then null else coalesce(p_dep, q.depart_at) end;
  v_ret := case when q.trip_type = 'one_way' or q.trip_shape = 'one_way_to' then null
                else coalesce(p_ret, q.return_at) end;
  if v_dep is null and v_ret is null then raise exception 'shift_car_invalid' using errcode = 'P0001'; end if;
  if v_dep is distinct from q.depart_at or v_ret is distinct from q.return_at then
    update public.requests set depart_at = v_dep, return_at = v_ret where id = q.id;
  end if;
  select * into q from public.requests where id = q.id;
  v_day := (coalesce(v_dep, v_ret) at time zone 'Asia/Jerusalem')::date;
  v_week_from := q.week_start::timestamp at time zone 'Asia/Jerusalem';
  v_week_until := (q.week_start + 7)::timestamp at time zone 'Asia/Jerusalem';
  v_buffer := coalesce(public.required_turnaround_minutes(q.department_id, q.week_start), 30);

  -- Replace the request's previous placement.
  for v_old in select rd.* from public.rides rd join public.ride_requests rr on rr.ride_id = rd.id
    where rr.request_id = q.id and rd.status <> 'cancelled' order by rd.id for update of rd loop
    continue when coalesce(current_setting('app.place_only_missing', true), 'off') = 'on';   -- R2B3: keep legs already served
    if exists(select 1 from public.ride_requests where ride_id = v_old.id and request_id <> q.id) then
      if not v_manual then raise exception 'shared_ride_requires_sadran'; end if;
    else
      update public.rides set status = 'cancelled', cancelled_at = now(),
        cancelled_by = coalesce(p_actor, q.requester_id), cancel_reason = 'REPLACED_BY_PROPOSAL' where id = v_old.id;
    end if;
    delete from public.ride_requests where ride_id = v_old.id and request_id = q.id;
    v_old_cars := v_old_cars || v_old.car_id;
  end loop;

  if q.trip_type = 'round_trip' then
    -- REQ §13.95 H3: a round trip is one ride, the requester (or a driving companion) drives, car kept.
    v_driver := public.eligible_leg_driver(q.id);
    if v_driver is null then raise exception 'non_driver_needs_drop_off' using errcode = 'P0001'; end if;
    if v_dep is null or v_ret is null then raise exception 'shift_car_invalid' using errcode = 'P0001'; end if;
    select home_destination_id into v_home from public.departments where id = q.department_id;
    v_loc := coalesce(q.origin_id, v_home);
    v_gap := null;
    if v_manual then v_gap := public.prepare_manual_ride_window(v_car, q.week_start, v_dep, v_ret, null); end if;
    insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id,
      status, is_pinned, pin_reason, created_by, turnaround_override_minutes)
    values(q.department_id, q.week_start, v_car, v_dep, v_ret, v_loc, v_loc, v_driver,
      case when v_public then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
      true, p_reason, p_actor, v_gap) returning id into v_ride;
    insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values(v_ride, q.id, 'driver', 'both', 'keep');
    v_first := v_ride; v_rides := array[v_ride];
    update public.requests set status = 'assigned', status_reason = p_reason where id = q.id;
  elsif q.trip_type = 'one_way' then
    if q.origin_id is null or q.destination_id is null then raise exception 'shift_car_invalid' using errcode = 'P0001'; end if;
    v_driver := public.eligible_leg_driver(q.id);
    if v_driver is null then raise exception 'no_eligible_driver' using errcode = 'P0001'; end if;
    v_travel := greatest(coalesce(public.request_leg_route_minutes(q.id, 'out'), 30), 0);
    v_end := greatest(public._round_up_ride_end(v_dep, v_dep + make_interval(mins => v_travel)), v_dep + interval '15 minutes');
    if public.car_location_at(v_car, v_dep) is distinct from q.origin_id then
      raise exception 'car_not_at_leg_origin' using errcode = 'P0001';
    end if;
    if coalesce(public.car_next_ride_origin(v_car, v_end), q.destination_id) <> q.destination_id then
      raise exception 'car_next_ride_elsewhere' using errcode = 'P0001';
    end if;
    v_gap := null;
    if v_manual then v_gap := public.prepare_manual_ride_window(v_car, q.week_start, v_dep, v_end, null); end if;
    insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id,
      status, is_pinned, pin_reason, created_by, turnaround_override_minutes)
    values(q.department_id, q.week_start, v_car, v_dep, v_end, q.origin_id, q.destination_id, v_driver,
      case when v_public then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
      true, p_reason, p_actor, v_gap) returning id into v_ride;
    insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values(v_ride, q.id, 'driver', 'out', 'relay');
    v_first := v_ride; v_rides := array[v_ride];
    update public.requests set status = 'assigned', status_reason = p_reason where id = q.id;
  else
    -- drop_off: one chauffeur ride per leg.
    v_named := p_named_driver;
    if v_named is not null and not exists(select 1 from public.department_members
      where department_id = q.department_id and profile_id = v_named and removed_at is null) then
      raise exception 'shift_car_invalid' using errcode = 'P0001';
    end if;
    select coalesce((w.settings_overrides ->> 'chauffeur_dwell_minutes')::int, s.chauffeur_dwell_minutes, 10) into v_dwell
    from public.department_settings s join public.weeks w on w.department_id = s.department_id and w.week_start = q.week_start
    where s.department_id = q.department_id;
    v_dwell := coalesce(v_dwell, 10);
    for k in 1..2 loop
      if k = 1 then v_leg := 'out'; v_at := v_dep; else v_leg := 'return'; v_at := v_ret; end if;
      continue when v_at is null;
      continue when coalesce(current_setting('app.place_only_missing', true), 'off') = 'on' and v_leg::text = any(public.request_covered_legs(q.id));
      v_wanted := v_wanted + 1;
      v_travel := greatest(coalesce(public.request_leg_route_minutes(q.id, v_leg), 30), 0);
      v_dur := greatest(15, ceil((2 * v_travel + greatest(v_dwell, 0)) / 15.0)::int * 15);
      v_ok := false;
      for c in 1..2 loop
        continue when c = 2 and v_leg <> 'out';
        if c = 1 then
          v_loc := q.origin_id;
          if v_leg = 'out' then v_s := v_at; v_e := v_at + make_interval(mins => v_dur);
          else v_e := v_at; v_s := v_at - make_interval(mins => v_dur); end if;
        else
          v_loc := q.destination_id;
          v_e := v_at + make_interval(mins => ceil(v_travel / 15.0)::int * 15); v_s := v_e - make_interval(mins => v_dur);
        end if;
        continue when v_loc is null or v_s < v_week_from or v_e > v_week_until
          or (v_s at time zone 'Asia/Jerusalem')::date <> v_day
          or ((v_e - interval '1 minute') at time zone 'Asia/Jerusalem')::date <> v_day
          or public.car_location_at(v_car, v_s) is distinct from v_loc
          or exists(select 1 from public.rides r where r.car_id = v_car and r.status <> 'cancelled'
            and tstzrange(r.starts_at, case when v_manual then r.ends_at else r.blocked_until end, '[)')
              && tstzrange(v_s, case when v_manual then v_e else v_e + make_interval(mins => v_buffer) end, '[)'))
          or exists(select 1 from public.car_maintenance_blocks b where b.car_id = v_car
            and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_s, v_e, '[)'));
        v_ok := true; exit;
      end loop;
      continue when not v_ok;
      v_gap := null;
      if v_manual then v_gap := public.prepare_manual_ride_window(v_car, q.week_start, v_s, v_e, null); end if;
      insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, needs_driver,
        status, is_pinned, pin_reason, created_by, turnaround_override_minutes)
      values(q.department_id, q.week_start, v_car, v_s, v_e, v_loc, v_loc, v_named, v_named is null,
        case when v_public then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
        true, case when v_named is null then 'MISSING_DRIVER' else p_reason end, p_actor, v_gap)
      returning id into v_ride;
      insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values(v_ride, q.id, 'passenger', v_leg, 'chauffeur');
      v_legs := v_legs + 1; v_rides := v_rides || v_ride;
      v_first := coalesce(v_first, v_ride);
    end loop;
    if v_legs = 0 then raise exception 'car_not_at_leg_place' using errcode = 'P0001'; end if;
    if v_named is null then
      update public.requests set status = 'waitlisted', status_reason = 'UNMET_NEEDS_DRIVER' where id = q.id;
    else
      update public.requests set status = 'assigned',
        status_reason = case when v_legs < v_wanted then p_reason || '_PARTIAL' else p_reason end where id = q.id;
    end if;
  end if;

  foreach v_rid in array v_rides loop
    perform public.assert_ride_request_day(v_rid);
    perform public.assert_ride_seats_fit(v_rid);
    perform public.assert_ride_driver(v_rid);
  end loop;
  perform public.assert_car_chain(v_car, q.week_start);
  foreach v_old_car in array v_old_cars loop
    if v_old_car <> v_car then perform public.assert_car_chain(v_old_car, q.week_start); end if;
  end loop;
  return v_first;
end;
$$;


CREATE OR REPLACE FUNCTION public.release_request_draft_rides(p_request_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare r record; ids uuid[]; v_cars uuid[] := '{}'; v_weeks date[] := '{}'; k int;
begin
  perform set_config('app.system_status_transition','on',true);
  for r in select rd.* from public.rides rd join public.ride_requests rr on rr.ride_id=rd.id where rr.request_id=p_request_id and rd.status='draft' order by rd.id for update of rd loop
    select array_agg(request_id) into ids from public.ride_requests where ride_id=r.id;
    v_cars := v_cars || r.car_id; v_weeks := v_weeks || r.week_start;
    update public.rides set status='cancelled',cancelled_at=now(),cancelled_by=(select auth.uid()),cancel_reason='REQUEST_EDITED' where id=r.id;
    delete from public.ride_requests where ride_id=r.id;
    update public.requests q set status='submitted',status_reason=null where id=any(ids) and not exists(
      select 1 from public.ride_requests rr join public.rides rd on rd.id=rr.ride_id where rr.request_id=q.id and rd.status<>'cancelled');
  end loop;
  perform set_config('app.system_status_transition','off',true);
  for k in 1..coalesce(cardinality(v_cars), 0) loop
    perform public.flag_car_chain_breaks(v_cars[k], v_weeks[k]);   -- R2B6
  end loop;
end $$;


ALTER FUNCTION "public"."release_request_draft_rides"("p_request_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."remove_ride_person"("p_ride_id" "uuid", "p_expected_version" integer, "p_key" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ride public.rides%rowtype;
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_destination_name text;
  v_route text;
  v_prefix text;
  v_request_id uuid;
  v_profile_id uuid;
  v_child_id uuid;
  v_ride_passenger_id uuid;
  v_n int;
  v_display_name text;
  v_new_version int;
  v_removed_person_id uuid;
  v_removed_child_id uuid;
  v_removed_display_name text;
  v_skip_notify boolean := false;
  v_guardian record;
begin
  select * into v_ride from public.rides where id = p_ride_id for update;
  if not found or v_ride.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;

  if not public.member_of(v_ride.department_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if not (public.is_week_public(v_ride.department_id, v_ride.week_start) or public.can_manage_week(v_ride.department_id, v_ride.week_start)) then
    raise exception 'ride_week_not_public' using errcode = 'P0001';
  end if;

  if p_expected_version is null or v_ride.version <> p_expected_version then
    perform public.raise_stale_version();
  end if;

  if exists (select 1 from public.weeks where department_id = v_ride.department_id and week_start = v_ride.week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;

  v_prefix := split_part(coalesce(p_key, ''), ':', 1);
  perform set_config('app.audit_reason', 'remove_ride_person', true);

  if v_prefix = 'driver' then
    raise exception 'ride_driver_not_removable' using errcode = 'P0001';

  elsif v_prefix = 'added' then
    v_ride_passenger_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    select person_id, child_id, display_name into v_removed_person_id, v_removed_child_id, v_removed_display_name
    from public.ride_passengers where id = v_ride_passenger_id and ride_id = p_ride_id;
    if not found then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    delete from public.ride_passengers where id = v_ride_passenger_id;
    v_skip_notify := v_removed_person_id is null and v_removed_child_id is null; -- free-text guest

  elsif v_prefix = 'comp' then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    v_profile_id := nullif(split_part(p_key, ':', 3), '')::uuid;
    if v_request_id is null or v_profile_id is null
      or not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id)
    then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    select full_name into v_removed_display_name from public.profiles where id = v_profile_id;
    delete from public.request_companions where request_id = v_request_id and profile_id = v_profile_id;
    update public.requests set updated_at = now() where id = v_request_id;
    v_removed_person_id := v_profile_id;

  elsif v_prefix = 'child' then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    v_child_id := nullif(split_part(p_key, ':', 3), '')::uuid;
    if v_request_id is null or v_child_id is null
      or not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id)
    then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    select full_name into v_removed_display_name from public.children where id = v_child_id;
    delete from public.request_children where request_id = v_request_id and child_id = v_child_id;
    update public.requests set updated_at = now() where id = v_request_id;
    v_removed_child_id := v_child_id;

  elsif v_prefix = 'guest' then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    v_n := nullif(split_part(p_key, ':', 3), '')::int;
    if v_request_id is null or v_n is null or v_n < 1
      or not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id)
    then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    update public.requests
      set guest_passenger_names = guest_passenger_names[1 : v_n - 1] || guest_passenger_names[v_n + 1 : cardinality(guest_passenger_names)]
      where id = v_request_id and v_n <= cardinality(guest_passenger_names);
    if not found then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    v_skip_notify := true; -- free-text guest: nobody is notified

  elsif v_prefix = 'req' then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    if v_request_id is null then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    select requester_id into v_profile_id from public.requests where id = v_request_id;
    if v_profile_id is null
      or not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id)
    then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    if v_profile_id = v_ride.driver_id then
      raise exception 'ride_driver_not_removable' using errcode = 'P0001';
    end if;
    select full_name into v_removed_display_name from public.profiles where id = v_profile_id;
    delete from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id;
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'withdrawn', status_reason = 'WITHDRAWN_BY_MEMBER' where id = v_request_id;
    perform set_config('app.system_status_transition', 'off', true);
    v_removed_person_id := v_profile_id;

  else
    raise exception 'invalid_ride_passenger' using errcode = 'P0001';
  end if;

  update public.rides set updated_at = now() where id = p_ride_id
  returning version into v_new_version;

  if not v_skip_notify then
    select full_name into v_actor_name from public.profiles where id = v_actor;

    -- The driver is always told who was removed, unless the driver is the one removing them.
    if v_ride.driver_id is not null and v_ride.driver_id is distinct from v_actor then
      perform public.enqueue_notification(v_ride.driver_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
        jsonb_build_object('byName', coalesce(v_actor_name, ''), 'names', coalesce(v_removed_display_name, '')),
        jsonb_build_object('variant', 'passengers_removed', 'ride_id', p_ride_id),
        format('passengers_removed:%s:%s:%s', p_ride_id, v_new_version, v_ride.driver_id));
    end if;

    if v_removed_person_id is not null and v_removed_person_id is distinct from v_actor then
      select name into v_destination_name from public.destinations where id = v_ride.destination_id;
      v_route := public.route_label(v_ride.department_id, v_ride.origin_id, null, v_ride.destination_id, null);
      perform public.enqueue_notification(v_removed_person_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
        jsonb_build_object('byName', coalesce(v_actor_name, ''), 'destination', coalesce(v_destination_name, ''), 'route', coalesce(v_route, '')),
        jsonb_build_object('variant', 'passenger_removed_you', 'ride_id', p_ride_id),
        format('passenger_removed_you:%s:%s:%s', p_ride_id, v_new_version, v_removed_person_id));
    end if;

    if v_removed_child_id is not null then
      select name into v_destination_name from public.destinations where id = v_ride.destination_id;
      v_route := public.route_label(v_ride.department_id, v_ride.origin_id, null, v_ride.destination_id, null);
      for v_guardian in select cg.profile_id from public.child_guardians cg where cg.child_id = v_removed_child_id loop
        if v_guardian.profile_id is distinct from v_actor then
          perform public.enqueue_notification(v_guardian.profile_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
            jsonb_build_object('byName', coalesce(v_actor_name, ''), 'childName', coalesce(v_removed_display_name, ''), 'destination', coalesce(v_destination_name, ''), 'route', coalesce(v_route, '')),
            jsonb_build_object('variant', 'child_removed', 'ride_id', p_ride_id),
            format('child_removed:%s:%s:%s:%s', p_ride_id, v_new_version, v_removed_child_id, v_guardian.profile_id));
        end if;
      end loop;
    end if;
  end if;
end;
$$;


CREATE OR REPLACE FUNCTION public.release_request_booking(p_request_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_req public.requests%rowtype; r public.rides%rowtype; v_ride_id uuid; v_actor uuid := (select auth.uid());
  v_names text; v_prev text;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  perform public.release_request_draft_rides(p_request_id);
  for v_ride_id in
    select rd.id from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
    where rr.request_id = p_request_id and rd.status not in ('cancelled', 'draft') order by rd.id
  loop
    select * into r from public.rides where id = v_ride_id for update;
    if r.status = 'cancelled' then continue; end if;
    if r.driver_id is not distinct from v_req.requester_id then
      perform public.cancel_ride_before_series(r.id, 'REQUEST_RELEASED', r.version);
    else
      v_prev := coalesce(current_setting('app.system_status_transition', true), 'off');
      perform set_config('app.audit_reason', 'request_released', true);
      perform set_config('app.system_status_transition', 'on', true);
      delete from public.ride_requests where ride_id = r.id and request_id = p_request_id;
      if not exists (select 1 from public.ride_requests where ride_id = r.id)
         and not exists (select 1 from public.ride_passengers where ride_id = r.id) then
        update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor,
          cancel_reason = 'REQUEST_RELEASED' where id = r.id;
        perform public.flag_car_chain_breaks(r.car_id, r.week_start);   -- R2B6
      else
        update public.rides set is_pinned = true where id = r.id;
      end if;
      perform set_config('app.system_status_transition', v_prev, true);
      if r.driver_id is not null then
        select full_name into v_names from public.profiles where id = v_req.requester_id;
        perform public.enqueue_notification(r.driver_id, 'outcome_changed', r.department_id, r.week_start,
          jsonb_build_object('names', coalesce(v_names, ''), 'route', coalesce(public.request_route_label(p_request_id), ''),
            'day', public.day_date_label(r.starts_at)),
          jsonb_build_object('variant', 'passenger_left', 'ride_id', r.id, 'request_id', p_request_id),
          format('passenger_left:%s:%s:%s', r.id, p_request_id, r.version));
      end if;
    end if;
  end loop;
  -- a released request keeps no link to a ride it is no longer on (a later placement needs the slot free)
  delete from public.ride_requests rr using public.rides rd
  where rr.request_id = p_request_id and rd.id = rr.ride_id and rd.status = 'cancelled';
end $$;


ALTER FUNCTION "public"."release_request_booking"("p_request_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_request_draft_rides"("p_request_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare r record; ids uuid[];
begin
  perform set_config('app.system_status_transition','on',true);
  for r in select rd.* from public.rides rd join public.ride_requests rr on rr.ride_id=rd.id where rr.request_id=p_request_id and rd.status='draft' order by rd.id for update of rd loop
    select array_agg(request_id) into ids from public.ride_requests where ride_id=r.id;
    update public.rides set status='cancelled',cancelled_at=now(),cancelled_by=(select auth.uid()),cancel_reason='REQUEST_EDITED' where id=r.id;
    delete from public.ride_requests where ride_id=r.id;
    update public.requests q set status='submitted',status_reason=null where id=any(ids) and not exists(
      select 1 from public.ride_requests rr join public.rides rd on rd.id=rr.ride_id where rr.request_id=q.id and rd.status<>'cancelled');
  end loop;
  perform set_config('app.system_status_transition','off',true);
end $$;


ALTER FUNCTION "public"."release_request_draft_rides"("p_request_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."remove_ride_person"("p_ride_id" "uuid", "p_expected_version" integer, "p_key" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_ride public.rides%rowtype;
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_destination_name text;
  v_route text;
  v_prefix text;
  v_request_id uuid;
  v_profile_id uuid;
  v_child_id uuid;
  v_ride_passenger_id uuid;
  v_n int;
  v_display_name text;
  v_new_version int;
  v_removed_person_id uuid;
  v_removed_child_id uuid;
  v_removed_display_name text;
  v_skip_notify boolean := false;
  v_guardian record;
begin
  select * into v_ride from public.rides where id = p_ride_id for update;
  if not found or v_ride.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;

  if not public.member_of(v_ride.department_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if not (public.is_week_public(v_ride.department_id, v_ride.week_start) or public.can_manage_week(v_ride.department_id, v_ride.week_start)) then
    raise exception 'ride_week_not_public' using errcode = 'P0001';
  end if;

  if p_expected_version is null or v_ride.version <> p_expected_version then
    perform public.raise_stale_version();
  end if;

  if exists (select 1 from public.weeks where department_id = v_ride.department_id and week_start = v_ride.week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;

  v_prefix := split_part(coalesce(p_key, ''), ':', 1);
  perform set_config('app.audit_reason', 'remove_ride_person', true);

  if v_prefix = 'driver' then
    raise exception 'ride_driver_not_removable' using errcode = 'P0001';

  elsif v_prefix = 'added' then
    v_ride_passenger_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    select person_id, child_id, display_name into v_removed_person_id, v_removed_child_id, v_removed_display_name
    from public.ride_passengers where id = v_ride_passenger_id and ride_id = p_ride_id;
    if not found then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    delete from public.ride_passengers where id = v_ride_passenger_id;
    v_skip_notify := v_removed_person_id is null and v_removed_child_id is null; -- free-text guest

  elsif v_prefix = 'comp' then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    v_profile_id := nullif(split_part(p_key, ':', 3), '')::uuid;
    if v_request_id is null or v_profile_id is null
      or not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id)
    then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    select full_name into v_removed_display_name from public.profiles where id = v_profile_id;
    delete from public.request_companions where request_id = v_request_id and profile_id = v_profile_id;
    update public.requests set updated_at = now() where id = v_request_id;
    v_removed_person_id := v_profile_id;

  elsif v_prefix = 'child' then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    v_child_id := nullif(split_part(p_key, ':', 3), '')::uuid;
    if v_request_id is null or v_child_id is null
      or not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id)
    then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    select full_name into v_removed_display_name from public.children where id = v_child_id;
    delete from public.request_children where request_id = v_request_id and child_id = v_child_id;
    update public.requests set updated_at = now() where id = v_request_id;
    v_removed_child_id := v_child_id;

  elsif v_prefix = 'guest' then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    v_n := nullif(split_part(p_key, ':', 3), '')::int;
    if v_request_id is null or v_n is null or v_n < 1
      or not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id)
    then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    update public.requests
      set guest_passenger_names = guest_passenger_names[1 : v_n - 1] || guest_passenger_names[v_n + 1 : cardinality(guest_passenger_names)]
      where id = v_request_id and v_n <= cardinality(guest_passenger_names);
    if not found then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    v_skip_notify := true; -- free-text guest: nobody is notified

  elsif v_prefix = 'req' then
    v_request_id := nullif(split_part(p_key, ':', 2), '')::uuid;
    if v_request_id is null then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
    select requester_id into v_profile_id from public.requests where id = v_request_id;
    if v_profile_id is null
      or not exists (select 1 from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id)
    then
      raise exception 'ride_not_found' using errcode = 'P0001';
    end if;
    if v_profile_id = v_ride.driver_id then
      raise exception 'ride_driver_not_removable' using errcode = 'P0001';
    end if;
    select full_name into v_removed_display_name from public.profiles where id = v_profile_id;
    delete from public.ride_requests where ride_id = p_ride_id and request_id = v_request_id;
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'withdrawn', status_reason = 'WITHDRAWN_BY_MEMBER' where id = v_request_id;
    perform set_config('app.system_status_transition', 'off', true);
    v_removed_person_id := v_profile_id;

  else
    raise exception 'invalid_ride_passenger' using errcode = 'P0001';
  end if;

  update public.rides set updated_at = now() where id = p_ride_id
  returning version into v_new_version;

  if not v_skip_notify then
    select full_name into v_actor_name from public.profiles where id = v_actor;

    -- The driver is always told who was removed, unless the driver is the one removing them.
    if v_ride.driver_id is not null and v_ride.driver_id is distinct from v_actor then
      perform public.enqueue_notification(v_ride.driver_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
        jsonb_build_object('byName', coalesce(v_actor_name, ''), 'names', coalesce(v_removed_display_name, '')),
        jsonb_build_object('variant', 'passengers_removed', 'ride_id', p_ride_id),
        format('passengers_removed:%s:%s:%s', p_ride_id, v_new_version, v_ride.driver_id));
    end if;

    if v_removed_person_id is not null and v_removed_person_id is distinct from v_actor then
      select name into v_destination_name from public.destinations where id = v_ride.destination_id;
      v_route := public.route_label(v_ride.department_id, v_ride.origin_id, null, v_ride.destination_id, null);
      perform public.enqueue_notification(v_removed_person_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
        jsonb_build_object('byName', coalesce(v_actor_name, ''), 'destination', coalesce(v_destination_name, ''), 'route', coalesce(v_route, '')),
        jsonb_build_object('variant', 'passenger_removed_you', 'ride_id', p_ride_id),
        format('passenger_removed_you:%s:%s:%s', p_ride_id, v_new_version, v_removed_person_id));
    end if;

    if v_removed_child_id is not null then
      select name into v_destination_name from public.destinations where id = v_ride.destination_id;
      v_route := public.route_label(v_ride.department_id, v_ride.origin_id, null, v_ride.destination_id, null);
      for v_guardian in select cg.profile_id from public.child_guardians cg where cg.child_id = v_removed_child_id loop
        if v_guardian.profile_id is distinct from v_actor then
          perform public.enqueue_notification(v_guardian.profile_id, 'outcome_changed', v_ride.department_id, v_ride.week_start,
            jsonb_build_object('byName', coalesce(v_actor_name, ''), 'childName', coalesce(v_removed_display_name, ''), 'destination', coalesce(v_destination_name, ''), 'route', coalesce(v_route, '')),
            jsonb_build_object('variant', 'child_removed', 'ride_id', p_ride_id),
            format('child_removed:%s:%s:%s:%s', p_ride_id, v_new_version, v_removed_child_id, v_guardian.profile_id));
        end if;
      end loop;
    end if;
  end if;
end;
$$;

