-- QA run 15 (R15B6, 2026-10-27): notices with empty pieces. `freed_slot` named no car, `claim_contested` (to the
-- Sadran) no car/day/time, `claim_declined` no route (it carried no request), and ride-only notices such as
-- "the driver cancelled - you drive" read "ל · …" with no place. Full definitions from schema-current.sql; the changes:
--   notification_context: a ride-only notice takes the recipient's own request on that ride (else the first served);
--   resolve_freed_offer: `freed_slot` passes the car, `claim_contested` the car, day and the freed window;
--   approve_claim: `claim_declined` carries the member's request id.

create or replace function public.notification_context("_recipient" "uuid", "_department_id" "uuid", "_week_start" "date", "_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare q public.requests%rowtype; r public.rides%rowtype; pr public.proposals%rowtype; w public.weeks%rowtype;
  v jsonb; dt timestamptz; dest text; fullname text; carname text;
  v_home uuid; v_origin_name text; v_origin text; v_route text; v_trip_type text;
  v_dep timestamptz; v_ret timestamptz; v_merge_out boolean; v_merge_ret boolean;
begin
  select * into w from public.weeks where department_id=_department_id and week_start=_week_start;
  select * into pr from public.proposals where id=nullif(_data->>'proposal_id','')::uuid;
  select * into q from public.requests where id=coalesce(nullif(_data->>'request_id','')::uuid,pr.request_id);
  select rd.* into r from public.rides rd where rd.id=coalesce(nullif(_data->>'ride_id','')::uuid,pr.ride_id,
    (select rr.ride_id from public.ride_requests rr join public.rides x on x.id=rr.ride_id where rr.request_id=q.id and x.status<>'cancelled' limit 1));
  -- QA run 15 (R15B6): a notice that names only a ride ("the driver cancelled - you drive") takes its route and times
  -- from the recipient's own request on that ride, else the first request it serves (before: "ל" with no place).
  if q.id is null and r.id is not null then
    select x.* into q from public.ride_requests rr join public.requests x on x.id=rr.request_id
    where rr.ride_id=r.id order by (x.requester_id=_recipient) desc, x.created_at, x.id limit 1;
  end if;
  select name into dest from public.destinations where id=q.destination_id;
  select full_name into fullname from public.profiles where id=coalesce(q.requester_id,_recipient);
  select name into carname from public.cars where id=r.car_id;
  dt:=coalesce(q.depart_at,q.return_at,r.starts_at);

  -- A merge proposal's times are the joiner's own legs, never the host ride's (series) window (R2B4).
  if pr.type = 'merge' then
    select coalesce(bool_or(coalesce(l->>'leg','both') in ('out','both')), false),
           coalesce(bool_or(coalesce(l->>'leg','both') in ('return','both')), false)
      into v_merge_out, v_merge_ret from jsonb_array_elements(coalesce(pr.payload->'legs','[]')) l;
    v_dep := case when v_merge_out then q.depart_at end;
    v_ret := case when v_merge_ret then q.return_at end;
  else
    v_dep := coalesce(r.starts_at,q.depart_at);
    v_ret := coalesce(r.ends_at,q.return_at);
  end if;

  select home_destination_id into v_home from public.departments where id=_department_id;
  select name into v_origin_name from public.destinations where id=q.origin_id;
  v_origin_name := coalesce(v_origin_name, q.origin_text);
  v_origin := case when q.id is null or q.origin_id is null or q.origin_id = v_home then '' else coalesce(v_origin_name,'') end;

  if q.id is not null then
    v_route := public.request_route_label(q.id);
  else
    v_route := public.render_notification_text(
      (select body from public.text_fragments where key='route.to'),
      jsonb_build_object('destination', coalesce(dest,q.destination_text,'')));
  end if;

  v_trip_type := coalesce((select body from public.text_fragments where key = 'trip_type.' || q.trip_type::text), '');

  v:=jsonb_build_object('weekLabel',public.week_range_label(_week_start),
    'closeTime',public._dt_label(w.close_at),
    'firstName',coalesce(fullname,''),'destination',coalesce(dest,q.destination_text,''),
    'origin',v_origin,'route',coalesce(v_route,''),'tripType',v_trip_type,
    'date',to_char(dt at time zone 'Asia/Jerusalem','DD/MM/YY'),'day',public.day_date_label(dt),
    'depart',coalesce(to_char(v_dep at time zone 'Asia/Jerusalem','HH24:MI'),''),
    'return',coalesce(to_char(v_ret at time zone 'Asia/Jerusalem','HH24:MI'),''),
    'car',coalesce(carname,''),'outcomeLine',coalesce(carname,dest,q.destination_text,''),
    'diffLine',concat_ws(' · ',carname,public._dt_label(coalesce(r.starts_at,dt))),
    'sadranName',(select full_name from public.profiles where id=pr.created_by),
    -- N3: the composer's stored WhatsApp text keeps `{{link}}` for send time; a member's
    -- inbox/push must never show the raw token (the row itself deep-links via _data.url).
    'proposalShort',public.render_notification_text(coalesce(pr.reason_he,''),jsonb_build_object('link','')),
    'expiresAt',public._dt_label(pr.expires_at),
    'count',coalesce(_data->>'count',''),'email',(select email from public.profiles where id=_recipient));
  return v;
end $$;

create or replace function public.resolve_freed_offer("p_offer_id" "uuid", "p_ranked_candidates" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_offer record;
  v_count int;
  v_first jsonb;
  v_ride_id uuid;
  v_cand jsonb;
  v_group uuid; v_g record; m record; v_car_name text;
  v_prio uuid[]; v_ok jsonb := '[]'::jsonb;
begin
  select * into v_offer from public.freed_slot_offers where id = p_offer_id;
  if v_offer is null then raise exception 'offer_not_found' using errcode = 'P0001'; end if;
  if v_offer.status <> 'open' then raise exception 'offer_not_open' using errcode = 'P0001'; end if;

  -- R12B3 (REQ §13.119): a candidate the freed car cannot really take (the car is not at the leg's place, a turnaround...)
  -- is dropped here, so the lone-candidate placement below cannot fail with car_not_at_leg_place.
  for v_cand in select * from jsonb_array_elements(coalesce(p_ranked_candidates, '[]')) loop
    if public.freed_candidate_placeable(p_offer_id, (v_cand ->> 'request_id')::uuid) then v_ok := v_ok || jsonb_build_array(v_cand); end if;
  end loop;
  p_ranked_candidates := v_ok;
  v_count := jsonb_array_length(p_ranked_candidates);
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

    perform public.enqueue_notification((v_first ->> 'requester_id')::uuid, 'freed_slot_auto', v_offer.department_id, v_offer.week_start,
      '{}'::jsonb, jsonb_build_object('ride_id', v_ride_id, 'request_id', (v_first ->> 'request_id')::uuid), format('freed_slot_auto:%s', p_offer_id));
  else
    for v_cand in select * from jsonb_array_elements(p_ranked_candidates) loop
      insert into public.freed_slot_claims (offer_id, request_id, profile_id, status, offered_at)
      values (p_offer_id, (v_cand ->> 'request_id')::uuid, (v_cand ->> 'requester_id')::uuid, 'offered', now())
      on conflict (offer_id, request_id) do nothing;
      -- R15B6: the car is named explicitly (the day and times come from the member's own request).
      perform public.enqueue_notification((v_cand ->> 'requester_id')::uuid, 'freed_slot', v_offer.department_id, v_offer.week_start,
        jsonb_build_object('car', coalesce((select name from public.cars where id = v_offer.car_id), '')),
        jsonb_build_object('offer_id', p_offer_id, 'request_id', (v_cand ->> 'request_id')::uuid),
        format('freed_slot:%s:%s', p_offer_id, v_cand ->> 'request_id'));
    end loop;
    update public.freed_slot_offers set status = 'pending_approval' where id = p_offer_id;
    perform public.enqueue_notification(s.profile_id, 'claim_contested', v_offer.department_id, v_offer.week_start,
      jsonb_build_object('count', v_count::text, 'car', coalesce((select name from public.cars where id = v_offer.car_id), ''),
        'day', public.day_date_label(v_offer.starts_at),
        'timeRange', to_char(v_offer.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI') || '–' || to_char(v_offer.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI')),
      jsonb_build_object('offer_id', p_offer_id), format('claim_contested:%s', p_offer_id))
    from public.sadranim_of(v_offer.department_id, v_offer.week_start) as s(profile_id);
  end if;
end;
$$;

create or replace function public.approve_claim("p_offer_id" "uuid", "p_request_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
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
    '{}'::jsonb, jsonb_build_object('offer_id', p_offer_id, 'request_id', fc.request_id), format('claim_declined:%s:%s', p_offer_id, fc.profile_id))
  from public.freed_slot_claims fc where fc.offer_id = p_offer_id and fc.request_id <> p_request_id and fc.status = 'declined';

  return v_ride_id;
end;
$$;
