-- REQ §13.102 (R2B4, R2B10, R2M2): per-reader proposal copy without empty values, non-changes, midnight times or a
-- reused joiner text. Joiner times come from the route ETA of the joiner's own boarding stop (rounded to 5 minutes),
-- falling back to the joiner's own request times for the leg - never the ride's (series) window. A merge may carry
-- legs on two different rides (split merge): one joiner text lists both, each host reads only its own ride.
insert into public.text_fragments (key, body) values
  ('time.depart_set', 'יציאה {{new}}'),
  ('time.return_set', 'חזרה {{new}}'),
  ('time.depart_day_set', 'יציאה ביום {{new}}'),
  ('time.return_day_set', 'חזרה ביום {{new}}')
on conflict (key) do update set body = excluded.body, updated_at = now();

-- "old -> new" line: only what changes; when there is no old value only the new one is stated (never "במקום .").
create or replace function public._time_change_line(_old_start timestamptz, _old_end timestamptz,
  _new_start timestamptz, _new_end timestamptz, _day_level boolean default false) returns text
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_parts text[] := '{}';
  v_day boolean;
begin
  if _new_start is not null and _old_start is distinct from _new_start then
    if _old_start is null then
      v_parts := v_parts || public._frag(case when _day_level then 'time.depart_day_set' else 'time.depart_set' end,
        jsonb_build_object('new', case when _day_level then public.day_date_label(_new_start) || ' ' || public._hhmm(_new_start) else public._hhmm(_new_start) end));
    else
      v_day := _day_level or (_old_start at time zone 'Asia/Jerusalem')::date <> (_new_start at time zone 'Asia/Jerusalem')::date;
      v_parts := v_parts || public._frag(case when v_day then 'time.depart_day_change' else 'time.depart_change' end,
        jsonb_build_object(
          'new', case when v_day then public.day_date_label(_new_start) || ' ' || public._hhmm(_new_start) else public._hhmm(_new_start) end,
          'old', case when v_day then public.day_date_label(_old_start) || ' ' || public._hhmm(_old_start) else public._hhmm(_old_start) end));
    end if;
  end if;
  if _new_end is not null and _old_end is distinct from _new_end then
    if _old_end is null then
      v_parts := v_parts || public._frag(case when _day_level then 'time.return_day_set' else 'time.return_set' end,
        jsonb_build_object('new', case when _day_level then public.day_date_label(_new_end) || ' ' || public._hhmm(_new_end) else public._hhmm(_new_end) end));
    else
      v_day := _day_level or (_old_end at time zone 'Asia/Jerusalem')::date <> (_new_end at time zone 'Asia/Jerusalem')::date;
      v_parts := v_parts || public._frag(case when v_day then 'time.return_day_change' else 'time.return_change' end,
        jsonb_build_object(
          'new', case when v_day then public.day_date_label(_new_end) || ' ' || public._hhmm(_new_end) else public._hhmm(_new_end) end,
          'old', case when v_day then public.day_date_label(_old_end) || ' ' || public._hhmm(_old_end) else public._hhmm(_old_end) end));
    end if;
  end if;
  return array_to_string(v_parts, ' · ');
end $$;

create or replace function public._round5(_at timestamptz) returns timestamptz
language sql immutable set search_path = public, pg_temp as $$
  select case when _at is null then null else to_timestamp(round(extract(epoch from _at) / 300.0) * 300.0) end
$$;

-- The joiner's own boarding times on a ride for the legs they take: route ETA, else their own request times.
create or replace function public._joiner_times(_ride_id uuid, _request_id uuid, _leg public.ride_leg,
  out dep timestamptz, out ret timestamptz) language plpgsql stable security definer
set search_path = public, pg_temp as $$
declare q public.requests%rowtype;
begin
  select * into q from public.requests where id = _request_id;
  select max(case when x.leg = 'out' then x.eta end), max(case when x.leg = 'return' then x.eta end) into dep, ret
  from public._ride_route_with(_ride_id, _request_id, _leg) x where x.request_id = _request_id and x.kind = 'board';
  dep := public._round5(coalesce(dep, case when _leg in ('out', 'both') then q.depart_at end));
  ret := public._round5(coalesce(ret, case when _leg in ('return', 'both') then q.return_at end));
  if _leg = 'return' then dep := null; elsif _leg = 'out' then ret := null; end if;
end $$;

create or replace function public._window_text(_dep timestamptz, _ret timestamptz) returns text
language sql stable set search_path = public, pg_temp as $$
  select public._frag(case when _dep is not null and _ret is not null then 'window.both'
                           when _dep is not null then 'window.out' else 'window.return' end,
    jsonb_build_object('depart', coalesce(public._hhmm(_dep), ''), 'return', coalesce(public._hhmm(_ret), '')))
$$;

create or replace function public.proposal_reader_vars(p_proposal_id uuid, p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  pr public.proposals%rowtype; q public.requests%rowtype; r public.rides%rowtype;
  v_variant text; v jsonb;
  v_home uuid; v_first text; v_sadran text; v_joiner text; v_driver text;
  v_car text; v_car_line text := ''; v_time_change text := ''; v_join_line text := ''; v_detour int := 0;
  v_route text; v_origin_name text; v_new_origin text; v_city text; v_dest_name text; v_dest_route text := '';
  v_leg text; v_mc jsonb; v_new_dep timestamptz; v_new_ret timestamptz; v_reason text;
  v_span jsonb; v_old_dep timestamptz; v_old_ret timestamptz; v_ride_id uuid;
  v_rides uuid[]; v_e jsonb; v_part text; v_parts text[] := '{}'; v_tc_parts text[] := '{}'; v_times text; v_tc text;
  v_placed boolean; v_leg_word text := ''; v_hint text; v_suggest text := ''; v_note text := '';
  v_jd timestamptz; v_jr timestamptz; v_ride_driver text; v_ride_car text; v_leg_raw text := '';
begin
  select * into pr from public.proposals where id = p_proposal_id;
  if pr.id is null then return null; end if;
  select * into q from public.requests where id = pr.request_id;
  select home_destination_id into v_home from public.departments where id = pr.department_id;
  select split_part(full_name, ' ', 1) into v_first from public.profiles where id = p_profile_id;
  select full_name into v_sadran from public.profiles where id = pr.created_by;
  select full_name into v_joiner from public.profiles where id = q.requester_id;
  select d.name into v_origin_name from public.destinations d where d.id = q.origin_id;
  v_origin_name := coalesce(v_origin_name, q.origin_text);
  v_route := public.request_route_label(q.id);
  select d.name into v_dest_name from public.destinations d where d.id = q.destination_id;
  v_dest_name := coalesce(v_dest_name, q.destination_text, '');
  v_dest_route := public._frag('route.to', jsonb_build_object('destination', v_dest_name));
  v_placed := exists(select 1 from public.ride_requests rr join public.rides x on x.id = rr.ride_id
                     where rr.request_id = q.id and x.status <> 'cancelled');

  if pr.type = 'shift' then
    v_variant := case when v_placed then 'shift_placed' else 'shift' end;
    select c.name into v_car from public.cars c where c.id = nullif(pr.payload ->> 'car_id', '')::uuid;
    v_span := pr.payload -> 'series_span';
    if v_span is not null then
      select min(x.depart_at), max(x.return_at) into v_old_dep, v_old_ret
      from public.requests x where x.series_id = q.series_id and x.status not in ('withdrawn', 'cancelled');
      v_time_change := public._time_change_line(v_old_dep, v_old_ret,
        (v_span ->> 'depart_at')::timestamptz, (v_span ->> 'return_at')::timestamptz, true);
    else
      v_time_change := public._time_change_line(q.depart_at, q.return_at,
        nullif(pr.payload ->> 'depart_at', '')::timestamptz, nullif(pr.payload ->> 'return_at', '')::timestamptz);
    end if;
    if v_time_change = '' then
      v_time_change := case when coalesce(v_car, '') <> ''
        then public._frag('time.same_with_car', jsonb_build_object('car', v_car))
        else public._frag('time.unchanged') end;
    elsif coalesce(v_car, '') <> '' then
      v_car_line := ' · ' || v_car;
    end if;

  elsif pr.type = 'merge' then
    select array_agg(x.rid order by x.ord) into v_rides
    from (select (l ->> 'ride_id')::uuid as rid, min(ord) as ord
          from jsonb_array_elements(coalesce(pr.payload -> 'legs', '[]')) with ordinality as t(l, ord)
          group by (l ->> 'ride_id')::uuid) x;

    if p_profile_id = q.requester_id then
      -- The joiner: every leg entry, each on its own ride.
      for v_e in select value from jsonb_array_elements(coalesce(pr.payload -> 'legs', '[]')) loop
        continue when coalesce(v_e ->> 'role', 'passenger') = 'driver';
        select * into r from public.rides where id = (v_e ->> 'ride_id')::uuid;
        v_leg := coalesce(v_e ->> 'leg', 'both');
        select dep, ret into v_jd, v_jr from public._joiner_times(r.id, q.id, v_leg::public.ride_leg);
        v_tc := public._time_change_line(case when v_leg in ('out', 'both') then q.depart_at end,
                                         case when v_leg in ('return', 'both') then q.return_at end, v_jd, v_jr);
        if v_tc <> '' then v_tc_parts := v_tc_parts || v_tc; end if;
        select c.name into v_ride_car from public.cars c where c.id = r.car_id;
        select full_name into v_ride_driver from public.profiles where id = r.driver_id;
        v_times := coalesce(nullif(v_tc, ''), concat_ws(', ',
          case when v_jd is not null then public._frag('time.depart_set', jsonb_build_object('new', public._hhmm(v_jd))) end,
          case when v_jr is not null then public._frag('time.return_set', jsonb_build_object('new', public._hhmm(v_jr))) end));
        v_parts := v_parts || public._frag(
          case when v_leg = 'return' then 'join.split_return' else 'join.split_out' end
            || case when r.driver_id is null then '_nodriver' else '' end,
          jsonb_build_object('driverName', coalesce(v_ride_driver, ''), 'car', coalesce(v_ride_car, ''), 'times', v_times));
        if v_ride_id is null then
          v_ride_id := r.id; v_car := v_ride_car; v_driver := v_ride_driver;
          v_new_dep := v_jd; v_new_ret := v_jr;
        end if;
        v_leg_raw := case when v_leg_raw = '' then v_leg else 'both' end;
      end loop;
      select * into r from public.rides where id = v_ride_id;
      if v_leg_raw <> '' then v_leg_word := public._frag('leg.' || v_leg_raw); end if;
      if coalesce(cardinality(v_rides), 0) > 1 then
        v_variant := 'merge_passenger_split';
        v_join_line := array_to_string(v_parts, public._frag('join.split_sep'));
        v_time_change := array_to_string(v_tc_parts, ' · ');
        v_car := null; v_driver := null;
      else
        v_variant := case when r.driver_id is null then 'merge_passenger_no_driver' else 'merge_passenger' end;
        v_time_change := array_to_string(v_tc_parts, ' · ');
        -- One line: the leg, then what changes - or, when nothing changes, the time itself (never both).
        v_join_line := case when v_time_change <> ''
          then public._frag('join.' || v_leg_raw || '_change', jsonb_build_object('change', v_time_change))
          else public._frag(case when v_new_dep is not null and v_new_ret is not null then 'join.both'
                                 when v_new_dep is not null then 'join.out' else 'join.return' end,
            jsonb_build_object('depart', coalesce(public._hhmm(v_new_dep), ''), 'return', coalesce(public._hhmm(v_new_ret), ''))) end;
      end if;
    else
      -- A host or a fellow passenger: the ride this reader is on, and only the joiner's legs on that ride.
      select x.rid into v_ride_id
      from unnest(v_rides) with ordinality as x(rid, ord)
      join public.rides rd on rd.id = x.rid
      where rd.driver_id = p_profile_id
         or exists (select 1 from public.ride_requests rr join public.requests rq on rq.id = rr.request_id
                    where rr.ride_id = rd.id and rq.requester_id = p_profile_id)
      order by (rd.driver_id = p_profile_id) desc, x.ord limit 1;
      v_ride_id := coalesce(v_ride_id, v_rides[1]);
      select * into r from public.rides where id = v_ride_id;
      select case when count(distinct coalesce(l ->> 'leg', 'both')) > 1 or bool_or(coalesce(l ->> 'leg', 'both') = 'both') then 'both'
                  else max(coalesce(l ->> 'leg', 'both')) end into v_leg
      from jsonb_array_elements(coalesce(pr.payload -> 'legs', '[]')) l
      where (l ->> 'ride_id')::uuid = r.id and coalesce(l ->> 'role', 'passenger') <> 'driver';
      select c.name into v_car from public.cars c where c.id = r.car_id;
      select full_name into v_driver from public.profiles where id = r.driver_id;
      if v_leg is not null then
        v_mc := public._merge_check(r.id, q.id, v_leg::public.ride_leg);
        v_detour := coalesce((v_mc ->> 'added_out_minutes')::int, 0) + coalesce((v_mc ->> 'added_return_minutes')::int, 0);
        v_leg_word := public._frag('leg.' || v_leg);
        v_time_change := public._time_change_line(r.starts_at, r.ends_at,
          (v_mc ->> 'new_starts_at')::timestamptz, (v_mc ->> 'new_ends_at')::timestamptz);
      end if;
      v_variant := (case when r.driver_id = p_profile_id then 'merge_host' else 'merge_other' end)
        || (case when pr.created_via = 'ask_to_join' then '_ask' else '' end);
      -- the ride's own trip (its base request), not the car's home-to-home movement
      select public.request_route_label(rr.request_id) into v_route
      from public.ride_requests rr where rr.ride_id = r.id
      order by (rr.role = 'driver') desc, rr.created_at, rr.request_id limit 1;
      v_route := coalesce(v_route, public.route_label(r.department_id, r.origin_id, null, r.destination_id, null));
    end if;
    if v_time_change = '' then v_time_change := public._frag('time.unchanged'); end if;

  elsif pr.type = 'external' then
    v_city := case when q.origin_id is null or q.origin_id = v_home then '' else coalesce(v_origin_name, '') end;
    v_variant := case when pr.payload ->> 'external_reason' = 'city' and v_city <> ''
                      then (case when q.destination_id is not distinct from v_home then 'external_city_home' else 'external_city' end)
                      else 'external_none' end;
    v_reason := nullif(btrim(coalesce(pr.payload ->> 'reason', '')), '');
    v_hint := coalesce(nullif(pr.payload ->> 'hint', ''), 'private');
    v_suggest := public._frag('external.hint.' || v_hint);
    if v_suggest = '' then v_suggest := public._frag('external.hint.private'); end if;
    if v_reason is not null then v_note := public._frag('reason.line', jsonb_build_object('reason', v_reason)) || chr(10); end if;

  elsif pr.type = 'deny' then
    v_variant := 'deny';
    v_reason := nullif(btrim(coalesce(pr.payload ->> 'reason', '')), '');

  elsif pr.type = 'origin' then
    v_variant := case when v_placed then 'origin_placed' else 'origin' end;
    select c.name into v_car from public.cars c where c.id = nullif(pr.payload ->> 'car_id', '')::uuid;
    select d.name into v_new_origin from public.destinations d where d.id = nullif(pr.payload ->> 'origin_id', '')::uuid;
  end if;

  v := jsonb_build_object(
    'firstName', coalesce(v_first, ''),
    'byName', coalesce(v_sadran, ''), 'sadranName', coalesce(v_sadran, ''),
    'route', coalesce(v_route, ''), 'destinationRoute', coalesce(v_dest_route, ''), 'destination', v_dest_name,
    'day', public.day_date_label(coalesce(q.depart_at, q.return_at)),
    'depart', coalesce(public._hhmm(q.depart_at), ''), 'return', coalesce(public._hhmm(q.return_at), ''),
    'window', public._window_text(q.depart_at, q.return_at),
    'car', coalesce(v_car, ''), 'carLine', v_car_line,
    'timeChange', v_time_change, 'joinLine', v_join_line, 'legWord', v_leg_word,
    'joinerName', coalesce(v_joiner, ''), 'driverName', coalesce(v_driver, ''),
    'detourMin', case when v_detour > 0 then v_detour::text else '' end,
    'detourLine', case when v_detour > 0 then public._frag('detour.line', jsonb_build_object('detourMin', v_detour)) else '' end,
    'city', coalesce(v_city, ''),
    'reason', coalesce(v_reason, ''),
    'reasonLine', case when v_reason is not null then public._frag('reason.line', jsonb_build_object('reason', v_reason))
                       else public._frag('reason.default') end,
    'reasonNote', v_note, 'externalSuggestion', v_suggest,
    'originOrHome', coalesce(v_origin_name, (select d.name from public.destinations d where d.id = v_home), ''),
    'newOrigin', coalesce(v_new_origin, ''),
    'newDepart', coalesce(public._hhmm(nullif(pr.payload ->> 'depart_at', '')::timestamptz), ''),
    'newReturn', coalesce(public._hhmm(nullif(pr.payload ->> 'return_at', '')::timestamptz), ''));
  return jsonb_build_object('variant', v_variant, 'vars', v);
end $$;

-- WhatsApp text per party, rendered from the same template rows and variables as push/inbox. Every proposal type is
-- rendered here (the Sadran's reason / suggestion sit inside the text, before the link); a type with no template
-- falls back to the composer's stored text.
create or replace function public.proposal_party_texts(p_proposal_id uuid)
returns table(profile_id uuid, variant text, body text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare pr public.proposals%rowtype; pp record; rv jsonb; v_tpl text; v_var text;
begin
  select * into pr from public.proposals where id = p_proposal_id;
  if pr.id is null then raise exception 'proposal_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(pr.department_id, pr.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  for pp in select x.profile_id as pid from public.proposal_parties x where x.proposal_id = p_proposal_id order by x.id loop
    rv := public.proposal_reader_vars(p_proposal_id, pp.pid);
    profile_id := pp.pid; variant := rv ->> 'variant'; v_var := rv ->> 'variant';
    select t.body into v_tpl from public.notification_templates t
    where t.event = 'proposal_received' and t.channel = 'whatsapp' and t.variant = v_var;
    if v_tpl is null then
      body := pr.reason_he;
    else
      body := replace(public.render_notification_text(v_tpl,
        (rv -> 'vars') || jsonb_build_object('link', '@@LINK@@')), '@@LINK@@', '{{link}}');
    end if;
    return next;
  end loop;
end $$;

create or replace function public.notification_context(_recipient uuid, _department_id uuid, _week_start date, _data jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
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

  v:=jsonb_build_object('weekLabel',to_char(_week_start,'DD/MM/YY'),
    'closeTime',to_char(w.close_at at time zone 'Asia/Jerusalem','DD/MM HH24:MI'),
    'firstName',coalesce(fullname,''),'destination',coalesce(dest,q.destination_text,''),
    'origin',v_origin,'route',coalesce(v_route,''),'tripType',v_trip_type,
    'date',to_char(dt at time zone 'Asia/Jerusalem','DD/MM/YY'),'day',public.day_date_label(dt),
    'depart',coalesce(to_char(v_dep at time zone 'Asia/Jerusalem','HH24:MI'),''),
    'return',coalesce(to_char(v_ret at time zone 'Asia/Jerusalem','HH24:MI'),''),
    'car',coalesce(carname,''),'outcomeLine',coalesce(carname,dest,q.destination_text,''),
    'diffLine',concat_ws(' · ',carname,to_char(coalesce(r.starts_at,dt) at time zone 'Asia/Jerusalem','DD/MM HH24:MI')),
    'sadranName',(select full_name from public.profiles where id=pr.created_by),
    -- N3: the composer's stored WhatsApp text keeps `{{link}}` for send time; a member's
    -- inbox/push must never show the raw token (the row itself deep-links via _data.url).
    'proposalShort',public.render_notification_text(coalesce(pr.reason_he,''),jsonb_build_object('link','')),
    'expiresAt',to_char(pr.expires_at at time zone 'Asia/Jerusalem','DD/MM HH24:MI'),
    'count',coalesce(_data->>'count',''),'email',(select email from public.profiles where id=_recipient));
  return v;
end $$;

create or replace function public.notification_context_extra(_data jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  q public.requests%rowtype; r public.rides%rowtype; pr public.proposals%rowtype;
  v_dep timestamptz; v_ret timestamptz; v_range text; v_series_ret timestamptz; v_all_day text;
  v_dep_mid boolean; v_ret_end boolean; v_merge_out boolean; v_merge_ret boolean;
begin
  select * into pr from public.proposals where id = nullif(_data->>'proposal_id','')::uuid;
  select * into q from public.requests where id = coalesce(nullif(_data->>'request_id','')::uuid, pr.request_id);
  select * into r from public.rides where id = coalesce(nullif(_data->>'ride_id','')::uuid, pr.ride_id);
  if pr.type = 'merge' then
    -- the joiner's own legs only (R2B4: never the host ride's series midnight)
    select coalesce(bool_or(coalesce(l->>'leg','both') in ('out','both')), false),
           coalesce(bool_or(coalesce(l->>'leg','both') in ('return','both')), false)
      into v_merge_out, v_merge_ret from jsonb_array_elements(coalesce(pr.payload->'legs','[]')) l;
    v_dep := case when v_merge_out then q.depart_at end;
    v_ret := case when v_merge_ret then q.return_at end;
    if v_dep is null and v_ret is null then return '{}'::jsonb; end if;
    return jsonb_build_object('timeRange', public._window_text(v_dep, v_ret), 'seriesReturnDay', '');
  end if;
  v_dep := coalesce(r.starts_at, q.depart_at);
  v_ret := coalesce(r.ends_at, q.return_at);
  if v_dep is null and v_ret is null then return '{}'::jsonb; end if;
  if v_dep is null or v_ret is null then
    return jsonb_build_object('timeRange', public._window_text(v_dep, v_ret), 'seriesReturnDay', '');
  end if;
  select body into v_all_day from public.text_fragments where key = 'time.all_day';
  v_dep_mid := (v_dep at time zone 'Asia/Jerusalem')::time = time '00:00';
  v_ret_end := (v_ret at time zone 'Asia/Jerusalem')::time >= time '23:59';
  v_range := case
    when v_dep_mid and v_ret_end and (q.series_id is not null or r.series_id is not null) then coalesce(v_all_day, '')
    when v_dep_mid and q.series_id is not null then to_char(v_ret at time zone 'Asia/Jerusalem','HH24:MI')
    when v_ret_end and q.series_id is not null then to_char(v_dep at time zone 'Asia/Jerusalem','HH24:MI')
    else to_char(v_dep at time zone 'Asia/Jerusalem','HH24:MI') || '–' || to_char(v_ret at time zone 'Asia/Jerusalem','HH24:MI')
  end;
  if coalesce(q.series_id, r.series_id) is not null then
    select max(x.return_at) into v_series_ret from public.requests x where x.series_id = coalesce(q.series_id, r.series_id);
  end if;
  return jsonb_build_object('timeRange', coalesce(v_range, ''),
    'seriesReturnDay', case when v_series_ret is null then '' else public.day_date_label(v_series_ret) end);
end $$;
