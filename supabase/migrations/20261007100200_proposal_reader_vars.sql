-- REQ §13.101 b / docs/COPY_DRAFT_2026-10.md §0-§5: one text per reader of a proposal.
-- `proposal_reader_vars(proposal, profile)` returns the notification variant and the variables for
-- that reader (old -> new lines from text_fragments, never Hebrew here):
--   shift   -> 'shift'                         (requester)
--   merge   -> 'merge_passenger' (the joiner), 'merge_host' (the ride's driver), 'merge_other' (other passengers)
--   external-> 'external_city' | 'external_none' (payload `external_reason`; no own-car variant, REQ §13.101 b)
--   deny    -> 'deny'; origin -> 'origin'
-- The Sadran is named only as `byName`/`sadranName` (display name); no text introduces them as "the Sadran".
-- `proposal_party_texts(proposal)` renders the per-party WhatsApp text (merge proposals; the other
-- types are single-party and keep the composer's stored text).
create or replace function public.proposal_reader_vars(p_proposal_id uuid, p_profile_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  pr public.proposals%rowtype; q public.requests%rowtype; r public.rides%rowtype;
  v_variant text; v jsonb;
  v_home uuid; v_first text; v_sadran text; v_joiner text; v_driver text;
  v_car text; v_car_line text := ''; v_time_change text := ''; v_join_line text := ''; v_detour int := 0;
  v_route text; v_origin_name text; v_new_origin text; v_city text;
  v_leg text; v_mc jsonb; v_new_dep timestamptz; v_new_ret timestamptz; v_reason text;
  v_span jsonb; v_old_dep timestamptz; v_old_ret timestamptz; v_ride_id uuid;
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

  if pr.type = 'shift' then
    v_variant := 'shift';
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
    -- the ride this reader is on (or, for the joiner, the first target ride)
    select x.ride_id into v_ride_id
    from (select (l ->> 'ride_id')::uuid as ride_id, ord from jsonb_array_elements(coalesce(pr.payload -> 'legs', '[]')) with ordinality as t(l, ord)) x
    join public.rides rd on rd.id = x.ride_id
    where p_profile_id = q.requester_id or rd.driver_id = p_profile_id
       or exists (select 1 from public.ride_requests rr join public.requests rq on rq.id = rr.request_id
                  where rr.ride_id = rd.id and rq.requester_id = p_profile_id)
    order by (rd.driver_id = p_profile_id) desc, x.ord limit 1;
    if v_ride_id is null then
      select (l ->> 'ride_id')::uuid into v_ride_id from jsonb_array_elements(coalesce(pr.payload -> 'legs', '[]')) l limit 1;
    end if;
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
    end if;

    if p_profile_id = q.requester_id then
      -- REQ §13.100 c: a ride that still needs a driver has no driver to name.
      v_variant := case when r.driver_id is null then 'merge_passenger_no_driver' else 'merge_passenger' end;
      if v_leg is not null then
        select max(case when x.leg = 'out' then x.eta end), max(case when x.leg = 'return' then x.eta end)
          into v_new_dep, v_new_ret
        from public._ride_route_with(r.id, q.id, v_leg::public.ride_leg) x
        where x.request_id = q.id and x.kind = 'board';
      end if;
      v_new_dep := coalesce(v_new_dep, case when v_leg in ('out', 'both') then r.starts_at end);
      v_new_ret := coalesce(v_new_ret, case when v_leg in ('return', 'both') then r.ends_at end);
      v_join_line := public._frag(case when v_new_dep is not null and v_new_ret is not null then 'join.both'
                                       when v_new_dep is not null then 'join.out' else 'join.return' end,
        jsonb_build_object('depart', public._hhmm(v_new_dep), 'return', public._hhmm(v_new_ret)));
      v_time_change := public._time_change_line(q.depart_at, q.return_at, v_new_dep, v_new_ret);
      v_route := public.request_route_label(q.id);
    else
      v_variant := case when r.driver_id = p_profile_id then 'merge_host' else 'merge_other' end;
      v_time_change := public._time_change_line(r.starts_at, r.ends_at,
        (v_mc ->> 'new_starts_at')::timestamptz, (v_mc ->> 'new_ends_at')::timestamptz);
      -- the ride's own trip (its base request), not the car's home-to-home movement
      select public.request_route_label(rr.request_id) into v_route
      from public.ride_requests rr where rr.ride_id = r.id
      order by (rr.role = 'driver') desc, rr.created_at, rr.request_id limit 1;
      v_route := coalesce(v_route, public.route_label(r.department_id, r.origin_id, null, r.destination_id, null));
    end if;
    if v_time_change = '' then v_time_change := public._frag('time.unchanged'); end if;

  elsif pr.type = 'external' then
    v_city := case when q.origin_id is null or q.origin_id = v_home then '' else coalesce(v_origin_name, '') end;
    v_variant := case when pr.payload ->> 'external_reason' = 'city' and v_city <> '' then 'external_city' else 'external_none' end;

  elsif pr.type = 'deny' then
    v_variant := 'deny';
    v_reason := nullif(btrim(coalesce(pr.payload ->> 'reason', '')), '');

  elsif pr.type = 'origin' then
    v_variant := 'origin';
    select c.name into v_car from public.cars c where c.id = nullif(pr.payload ->> 'car_id', '')::uuid;
    select d.name into v_new_origin from public.destinations d where d.id = nullif(pr.payload ->> 'origin_id', '')::uuid;
  end if;

  v := jsonb_build_object(
    'firstName', coalesce(v_first, ''),
    'byName', coalesce(v_sadran, ''), 'sadranName', coalesce(v_sadran, ''),
    'route', coalesce(v_route, ''),
    'day', public.day_date_label(coalesce(q.depart_at, q.return_at)),
    'depart', public._hhmm(q.depart_at), 'return', public._hhmm(q.return_at),
    'car', coalesce(v_car, ''), 'carLine', v_car_line,
    'timeChange', v_time_change, 'joinLine', v_join_line,
    'joinerName', coalesce(v_joiner, ''), 'driverName', coalesce(v_driver, ''),
    'detourMin', case when v_detour > 0 then v_detour::text else '' end,
    'detourLine', case when v_detour > 0 then public._frag('detour.line', jsonb_build_object('detourMin', v_detour)) else '' end,
    'city', coalesce(v_city, ''),
    'reason', coalesce(v_reason, ''),
    'reasonLine', case when v_reason is not null then public._frag('reason.line', jsonb_build_object('reason', v_reason))
                       else public._frag('reason.default') end,
    'originOrHome', coalesce(v_origin_name, (select d.name from public.destinations d where d.id = v_home), ''),
    'newOrigin', coalesce(v_new_origin, ''),
    'newDepart', public._hhmm(nullif(pr.payload ->> 'depart_at', '')::timestamptz),
    'newReturn', public._hhmm(nullif(pr.payload ->> 'return_at', '')::timestamptz));
  return jsonb_build_object('variant', v_variant, 'vars', v);
end $$;

revoke all on function public.proposal_reader_vars(uuid, uuid) from public;
grant execute on function public.proposal_reader_vars(uuid, uuid) to service_role;

-- Per-party WhatsApp text of a proposal (placeholders filled except `{{link}}`, which the composer
-- substitutes per recipient). Merge proposals render one text per reader; the single-party types
-- return the text the composer stored (`reason_he`).
create or replace function public.proposal_party_texts(p_proposal_id uuid)
returns table(profile_id uuid, variant text, body text)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare pr public.proposals%rowtype; pp record; rv jsonb; v_tpl text; v_wa text;
begin
  select * into pr from public.proposals where id = p_proposal_id;
  if pr.id is null then raise exception 'proposal_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(pr.department_id, pr.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  for pp in select x.profile_id as pid from public.proposal_parties x where x.proposal_id = p_proposal_id order by x.id loop
    rv := public.proposal_reader_vars(p_proposal_id, pp.pid);
    profile_id := pp.pid; variant := rv ->> 'variant';
    if pr.type = 'merge' then
      v_wa := case variant when 'merge_host' then 'merge_driver' else variant end;
      select t.body into v_tpl from public.notification_templates t
      where t.event = 'proposal_received' and t.channel = 'whatsapp' and t.variant = v_wa;
      body := replace(public.render_notification_text(coalesce(v_tpl, ''),
        (rv -> 'vars') || jsonb_build_object('link', '@@LINK@@')), '@@LINK@@', '{{link}}');
    else
      body := pr.reason_he;
    end if;
    return next;
  end loop;
end $$;

revoke all on function public.proposal_party_texts(uuid) from public, anon;
grant execute on function public.proposal_party_texts(uuid) to authenticated;
