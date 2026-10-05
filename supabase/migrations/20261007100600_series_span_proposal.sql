-- REQ §13.101 j: shift proposals may carry `series_span` (see 20261007100500); validate_proposal_payload accepts it and
-- create_proposal validates it by probing the real change in a rolled-back sub-block.
CREATE OR REPLACE FUNCTION public.validate_proposal_payload(_type proposal_type, _payload jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case _type
    when 'shift' then _payload ? 'series_span' or _payload ? 'depart_at' or _payload ? 'return_at' or _payload ? 'car_id'
      or _payload ? 'origin_id' or _payload ? 'origin_text'
      or _payload ? 'destination_id' or _payload ? 'destination_text' or _payload ? 'stops'
    when 'merge' then _payload ? 'ride_id' and _payload ? 'legs'
    when 'deny' then _payload ? 'reason'
    when 'external' then _payload ? 'hint' and _payload ? 'reason'
    when 'origin' then _payload ? 'origin_id' and _payload ? 'car_id'
    else false
  end;
$function$
;

CREATE OR REPLACE FUNCTION public.create_proposal(p_request_id uuid, p_ride_id uuid, p_type proposal_type, p_payload jsonb, p_reason_he text, p_party_profile_ids uuid[] DEFAULT '{}'::uuid[], p_created_via text DEFAULT 'sadran'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_req record;
  v_proposal_id uuid;
  v_token text;
  v_party uuid;
  host public.rides%rowtype;
  target_ids uuid[];
  required_parties uuid[];
  host_versions jsonb:='{}'; host_snapshots jsonb:='{}';
  source_versions jsonb:='{}';
  combined_start timestamptz;combined_end timestamptz;
  v_leg_txt text; v_check jsonb;
  v_orig_targets int; v_new_legs jsonb; v_e jsonb; v_h_leg public.ride_leg; v_p_ride uuid; v_p_leg public.ride_leg; v_host_car uuid;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;

  if p_created_via is null or p_created_via not in ('sadran','ask_to_join') then raise exception 'not_authorized'; end if;
  if p_created_via = 'sadran' and not public.can_manage_week(v_req.department_id, v_req.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  elsif p_created_via = 'ask_to_join' and v_req.requester_id <> (select auth.uid())
        and not public.can_manage_week(v_req.department_id, v_req.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  -- REQ §13.99: the Sadran never places/merges a request onto a private car (ask-to-join to the owner stays).
  if p_created_via = 'sadran' then
    if p_type = 'merge' then
      for v_host_car in select distinct rd.car_id from public.rides rd
        where rd.id in (select (l->>'ride_id')::uuid from jsonb_array_elements(coalesce(p_payload->'legs','[]')) l) loop
        perform public.assert_private_car_owner_only(v_host_car, (select auth.uid()), v_req.requester_id);
      end loop;
    elsif p_type in ('shift','origin') and nullif(p_payload->>'car_id','') is not null then
      perform public.assert_private_car_owner_only((p_payload->>'car_id')::uuid, (select auth.uid()), v_req.requester_id);
    end if;
  end if;

  -- Owner decision (20260910098000): a proposal cannot be created for a day that is
  -- already published — that day's coordination happens directly, not through the app.
  -- Ask to join is exempt: it is filed by submit_request(), not composed by the Sadran,
  -- and still needs to reach the temporary car's owner even on a published/live day.
  -- REQ §13.100 b: the Sadran may still create shift and merge proposals on a published day.
  if p_created_via <> 'ask_to_join' and p_type not in ('shift','merge')
     and public.is_day_public(v_req.department_id, v_req.week_start,
       (coalesce(v_req.depart_at, v_req.return_at) at time zone 'Asia/Jerusalem')::date)
  then
    raise exception 'proposal_day_public' using errcode = 'P0001';
  end if;

  if p_type='merge' then
    select array_agg(distinct (leg->>'ride_id')::uuid) into target_ids from jsonb_array_elements(coalesce(p_payload->'legs','[]')) leg;
    if coalesce(cardinality(target_ids),0)=0 then raise exception 'merge_target_required'; end if;
    v_orig_targets:=cardinality(target_ids);
    -- REQ §13.100 QB3: a "both ways" join into a connected drop-off pair rides each leg on its own ride.
    v_new_legs:='[]'::jsonb;
    for v_e in select value from jsonb_array_elements(p_payload->'legs') loop
      v_h_leg:=null; v_p_ride:=null; v_p_leg:=null;
      if coalesce(v_e->>'leg','both')='both' and coalesce(v_e->>'role','passenger')<>'driver' then
        select rr_h.leg, rr_p.ride_id, rr_p.leg into v_h_leg, v_p_ride, v_p_leg
        from public.ride_requests rr_h
        join public.rides h on h.id=rr_h.ride_id
        join public.ride_requests rr_p on rr_p.request_id=rr_h.request_id and rr_p.car_mode='relay'
          and rr_p.leg=(case when rr_h.leg='out' then 'return' else 'out' end)::public.ride_leg
        join public.rides rp on rp.id=rr_p.ride_id and rp.car_id=h.car_id and rp.status<>'cancelled' and rp.id<>h.id
        where rr_h.ride_id=(v_e->>'ride_id')::uuid and rr_h.car_mode='relay' and rr_h.leg in ('out','return')
        order by rr_h.leg limit 1;
      end if;
      if v_p_ride is not null then
        v_new_legs:=v_new_legs||jsonb_build_array(v_e||jsonb_build_object('leg',v_h_leg::text),
                                                  v_e||jsonb_build_object('ride_id',v_p_ride,'leg',v_p_leg::text));
      else
        v_new_legs:=v_new_legs||jsonb_build_array(v_e);
      end if;
    end loop;
    p_payload:=jsonb_set(p_payload,'{legs}',v_new_legs);
    select array_agg(distinct (leg->>'ride_id')::uuid) into target_ids from jsonb_array_elements(p_payload->'legs') leg;
    if cardinality(target_ids)>v_orig_targets then p_payload:=p_payload-'starts_at'-'ends_at'; end if;
    if v_orig_targets>1 and (p_payload ? 'starts_at' or p_payload ? 'ends_at') then raise exception 'merge_single_expanded_target_required'; end if;
    required_parties:=array[v_req.requester_id];
    for host in select * from public.rides where id=any(target_ids) order by id for update loop
      if host.department_id<>v_req.department_id or host.week_start<>v_req.week_start or host.status='cancelled' then raise exception 'not_authorized'; end if;
      combined_start:=least(host.starts_at,coalesce((p_payload->>'starts_at')::timestamptz,host.starts_at));
      combined_end:=greatest(host.ends_at,coalesce((p_payload->>'ends_at')::timestamptz,host.ends_at));
      if not public.is_quarter_hour(combined_start)
        or not (public.is_quarter_hour(combined_end) or (combined_end at time zone 'Asia/Jerusalem')::time=time '23:59')
        or combined_end<=combined_start
        or (combined_end at time zone 'Asia/Jerusalem')::date<>(combined_start at time zone 'Asia/Jerusalem')::date
        or (combined_start at time zone 'Asia/Jerusalem')::date<>(host.starts_at at time zone 'Asia/Jerusalem')::date
        or (combined_start at time zone 'Asia/Jerusalem')::date<>(coalesce(v_req.depart_at,v_req.return_at) at time zone 'Asia/Jerusalem')::date then raise exception 'ride_request_day_mismatch'; end if;
      if cardinality(target_ids)=1 then p_payload:=p_payload||jsonb_build_object('starts_at',combined_start,'ends_at',combined_end); end if;
      -- REQ §13.95 H1: boarding before the base ride's end, detour within the limits (the ride's own
      -- window moves at apply time; skipped when the request joins as the ride's driver).
      select case when count(distinct coalesce(l->>'leg','both'))>1 or bool_or(coalesce(l->>'leg','both')='both') then 'both'
                  else max(coalesce(l->>'leg','both')) end into v_leg_txt
      from jsonb_array_elements(coalesce(p_payload->'legs','[]')) l where (l->>'ride_id')::uuid=host.id and coalesce(l->>'role','passenger')<>'driver';
      if v_leg_txt is not null then
        v_check:=public._merge_check(host.id,v_req.id,v_leg_txt::public.ride_leg);
        if not (v_check->>'ok')::boolean then raise exception '%',v_check->>'error' using errcode='P0001'; end if;
      end if;
      host_versions:=host_versions||jsonb_build_object(host.id::text,host.version);
      host_snapshots:=host_snapshots||jsonb_build_object(host.id::text,jsonb_build_object('fp',public.ride_merge_fingerprint(host.id)));
      required_parties:=required_parties||array[host.driver_id]||array(select q.requester_id from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=host.id);
    end loop;
    if (select count(*) from jsonb_object_keys(host_versions))<>cardinality(target_ids) then raise exception 'ride_not_found'; end if;
    select coalesce(jsonb_object_agg(r.id::text,r.version),'{}') into source_versions from public.rides r join public.ride_requests rr on rr.ride_id=r.id
      where rr.request_id=v_req.id and r.status<>'cancelled' and not(r.id=any(target_ids));
    select array_agg(distinct id) into p_party_profile_ids from unnest(coalesce(p_party_profile_ids,'{}')||required_parties) id where id is not null;
    p_payload:=p_payload||jsonb_build_object('host_versions',host_versions,'host_snapshots',host_snapshots,'source_versions',source_versions,
      'request_fingerprint',public.merge_request_fingerprint(v_req.id),'allow_tight_turnaround',public.can_manage_week(v_req.department_id,v_req.week_start));
  elsif p_type='shift' and p_payload ? 'series_span' then
    -- REQ §13.101 j: fewer days for a multi-day request (series head, one car, consecutive sub-span).
    if p_created_via<>'sadran' then raise exception 'not_authorized' using errcode='P0001'; end if;
    if nullif(p_payload->>'car_id','') is null or jsonb_typeof(p_payload->'series_span')<>'object'
       or p_payload ? 'depart_at' or p_payload ? 'return_at' or p_payload ? 'origin_id' or p_payload ? 'origin_text'
       or p_payload ? 'destination_id' or p_payload ? 'destination_text' or p_payload ? 'stops' then
      raise exception 'series_span_invalid' using errcode='P0001';
    end if;
    if v_req.series_id is null or v_req.series_index is distinct from 1 then
      raise exception 'series_span_requires_series_head' using errcode='P0001';
    end if;
    -- Feasibility probe: run the real change inside a sub-block that always rolls back.
    begin
      perform public._apply_series_span(v_req.id,p_payload->'series_span',(p_payload->>'car_id')::uuid);
      raise exception 'series_span_probe_ok' using errcode='P0001';
    exception when others then
      if sqlerrm<>'series_span_probe_ok' then raise; end if;
    end;
  elsif p_type='shift' and (p_payload ? 'origin_id' or p_payload ? 'origin_text' or p_payload ? 'destination_id'
        or p_payload ? 'destination_text' or p_payload ? 'stops') then
    perform public._assert_shift_places(v_req.id, v_req.department_id, p_payload);
  elsif p_type='origin' then
    if p_created_via <> 'sadran' then raise exception 'not_authorized' using errcode = 'P0001'; end if;
    if nullif(p_payload->>'origin_id','') is null or nullif(p_payload->>'car_id','') is null then
      raise exception 'origin_proposal_requires_car_and_origin' using errcode = 'P0001';
    end if;
  end if;

  -- No timer any more: expires_at stays null until the proposal's day is
  -- published or has passed (expire_proposals(), 20260910090000, decides that).
  -- REQ §13.94 (board drafts): one open draft per request. A new Sadran draft supersedes the
  -- older one (it becomes `withdrawn`; the status guard leaves the request alone for drafts).
  if p_created_via = 'sadran' then
    perform set_config('app.audit_reason', 'create_proposal_supersede_draft', true);
    update public.proposals set status = 'withdrawn'
    where request_id = p_request_id and status = 'draft' and created_via = 'sadran';
  end if;

  v_token := public.generate_token();
  perform set_config('app.audit_reason', 'create_proposal', true);

  insert into public.proposals (department_id, week_start, type, status, request_id, ride_id, payload, reason_he,
    previous_status, token_hash, expires_at, created_by, created_via)
  values (v_req.department_id, v_req.week_start, p_type, 'draft', p_request_id, p_ride_id, p_payload, p_reason_he,
    v_req.status, encode(digest(v_token, 'sha256'), 'hex'), null, (select auth.uid()), p_created_via)
  returning id into v_proposal_id;

  v_token := public.generate_token();
  insert into public.proposal_parties (proposal_id, profile_id, request_id, token_hash)
  values (v_proposal_id, v_req.requester_id, p_request_id, encode(digest(v_token, 'sha256'), 'hex'));

  foreach v_party in array coalesce(p_party_profile_ids, '{}') loop
    if v_party <> v_req.requester_id then
      v_token := public.generate_token();
      insert into public.proposal_parties (proposal_id, profile_id, token_hash)
      values (v_proposal_id, v_party, encode(digest(v_token, 'sha256'), 'hex'))
      on conflict (proposal_id, profile_id) do nothing;
    end if;
  end loop;

  return v_proposal_id;
end;
$function$
;
