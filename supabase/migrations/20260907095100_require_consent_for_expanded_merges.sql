-- Merge expansions require every affected rider's consent, then apply atomically.
-- REQ §7.3; DATA_MODEL proposals/parties.
create function public.merge_request_fingerprint(p_request_id uuid) returns text
security definer stable set search_path=public,pg_temp language sql as $$
  select md5((to_jsonb(q)-array['status','status_reason','version','updated_at','changed_since_solve'])::text) from public.requests q where id=p_request_id;
$$;
revoke execute on function public.merge_request_fingerprint(uuid) from public,anon,authenticated;
create or replace function public.create_proposal(
  p_request_id uuid, p_ride_id uuid, p_type public.proposal_type, p_payload jsonb,
  p_reason_he text, p_party_profile_ids uuid[] default '{}', p_created_via text default 'sadran'
) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_req record;
  v_proposal_id uuid;
  v_token text;
  v_party uuid;
  v_expires_at timestamptz;
  v_settings record;
  host public.rides%rowtype;
  target_ids uuid[];
  required_parties uuid[];
  host_versions jsonb:='{}';
  source_versions jsonb:='{}';
  combined_start timestamptz;combined_end timestamptz;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;

  if p_created_via = 'sadran' and not public.can_manage_week(v_req.department_id, v_req.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  elsif p_created_via = 'ask_to_join' and v_req.requester_id <> (select auth.uid())
        and not public.can_manage_week(v_req.department_id, v_req.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  if p_type='merge' then
    select array_agg(distinct (leg->>'ride_id')::uuid) into target_ids from jsonb_array_elements(coalesce(p_payload->'legs','[]')) leg;
    if coalesce(cardinality(target_ids),0)=0 then raise exception 'merge_target_required'; end if;
    if cardinality(target_ids)>1 and (p_payload ? 'starts_at' or p_payload ? 'ends_at') then raise exception 'merge_single_expanded_target_required'; end if;
    required_parties:=array[v_req.requester_id];
    for host in select * from public.rides where id=any(target_ids) order by id for update loop
      if host.department_id<>v_req.department_id or host.week_start<>v_req.week_start or host.status='cancelled' then raise exception 'not_authorized'; end if;
      combined_start:=least(host.starts_at,coalesce((p_payload->>'starts_at')::timestamptz,host.starts_at));
      combined_end:=greatest(host.ends_at,coalesce((p_payload->>'ends_at')::timestamptz,host.ends_at));
      if not public.is_quarter_hour(combined_start) or not public.is_quarter_hour(combined_end)
        or (combined_start at time zone 'Asia/Jerusalem')::date<>(host.starts_at at time zone 'Asia/Jerusalem')::date
        or (combined_start at time zone 'Asia/Jerusalem')::date<>(coalesce(v_req.depart_at,v_req.return_at) at time zone 'Asia/Jerusalem')::date then raise exception 'ride_request_day_mismatch'; end if;
      if cardinality(target_ids)=1 then p_payload:=p_payload||jsonb_build_object('starts_at',combined_start,'ends_at',combined_end); end if;
      host_versions:=host_versions||jsonb_build_object(host.id::text,host.version);
      required_parties:=required_parties||array[host.driver_id]||array(select q.requester_id from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=host.id);
    end loop;
    if (select count(*) from jsonb_object_keys(host_versions))<>cardinality(target_ids) then raise exception 'ride_not_found'; end if;
    select coalesce(jsonb_object_agg(r.id::text,r.version),'{}') into source_versions from public.rides r join public.ride_requests rr on rr.ride_id=r.id
      where rr.request_id=v_req.id and r.status<>'cancelled' and not(r.id=any(target_ids));
    select array_agg(distinct id) into p_party_profile_ids from unnest(coalesce(p_party_profile_ids,'{}')||required_parties) id where id is not null;
    p_payload:=p_payload||jsonb_build_object('host_versions',host_versions,'source_versions',source_versions,
      'request_fingerprint',public.merge_request_fingerprint(v_req.id),'allow_tight_turnaround',public.can_manage_week(v_req.department_id,v_req.week_start));
  end if;

  select * into v_settings from public.department_settings where department_id = v_req.department_id;
  v_expires_at := case when v_settings.proposal_expiry_mode = 'fixed_hours'
    then now() + make_interval(hours => v_settings.proposal_expiry_hours)
    else (select w.publish_at from public.weeks w where w.department_id = v_req.department_id and w.week_start = v_req.week_start)
    end;

  v_token := public.generate_token();
  perform set_config('app.audit_reason', 'create_proposal', true);

  insert into public.proposals (department_id, week_start, type, status, request_id, ride_id, payload, reason_he,
    previous_status, token_hash, expires_at, created_by, created_via)
  values (v_req.department_id, v_req.week_start, p_type, 'draft', p_request_id, p_ride_id, p_payload, p_reason_he,
    v_req.status, encode(digest(v_token, 'sha256'), 'hex'), v_expires_at, (select auth.uid()), p_created_via)
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
$$;

revoke execute on function public.create_proposal(uuid, uuid, public.proposal_type, jsonb, text, uuid[], text) from public, anon;
grant execute on function public.create_proposal(uuid, uuid, public.proposal_type, jsonb, text, uuid[], text) to authenticated;

create or replace function public.send_proposal(p_proposal_id uuid, p_sent_via public.notification_channel[] default '{}') returns jsonb
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_prop record;
  v_requester_id uuid;
  v_token text;
  v_proposal_token text;
  v_party_tokens jsonb := '{}'::jsonb;
  v_party record;
begin
  select * into v_prop from public.proposals where id = p_proposal_id;
  if v_prop is null then raise exception 'proposal_not_found' using errcode = 'P0001'; end if;
  if v_prop.created_via = 'sadran' and not public.can_manage_week(v_prop.department_id, v_prop.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if v_prop.status <> 'draft' then raise exception 'proposal_not_draft' using errcode = 'P0001'; end if;

  perform set_config('app.audit_reason', 'send_proposal', true);

  v_proposal_token := public.generate_token();
  update public.proposals set token_hash = encode(digest(v_proposal_token, 'sha256'), 'hex'), status = 'sent',
    sent_at = now(), sent_via = p_sent_via
  where id = p_proposal_id;

  for v_party in select id, profile_id from public.proposal_parties where proposal_id = p_proposal_id loop
    v_token := public.generate_token();
    update public.proposal_parties set token_hash = encode(digest(v_token, 'sha256'), 'hex') where id = v_party.id;
    v_party_tokens := v_party_tokens || jsonb_build_object(v_party.profile_id::text, v_token);
  end loop;

  for v_party in select profile_id from public.proposal_parties where proposal_id=p_proposal_id loop
    perform public.enqueue_notification(v_party.profile_id,'proposal_received',v_prop.department_id,v_prop.week_start,
      jsonb_build_object('newDepart',to_char((v_prop.payload->>'starts_at')::timestamptz at time zone 'Asia/Jerusalem','HH24:MI'),
        'newReturn',to_char((v_prop.payload->>'ends_at')::timestamptz at time zone 'Asia/Jerusalem','HH24:MI')),
      jsonb_build_object('proposal_id',p_proposal_id,'url','/p/'||(v_party_tokens->>v_party.profile_id::text)),
      format('proposal_received:%s:%s',p_proposal_id,v_party.profile_id));
  end loop;

  return jsonb_build_object('proposal_token', v_proposal_token, 'party_tokens', v_party_tokens);
end;
$$;

revoke execute on function public.send_proposal(uuid, public.notification_channel[]) from public, anon;
grant execute on function public.send_proposal(uuid, public.notification_channel[]) to authenticated;

create or replace function public.apply_proposal(p_proposal_id uuid) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_prop record;
  v_req record;
  v_ride_id uuid;
  v_leg jsonb;
  v_has_driver_leg boolean;
  v_is_auto_apply boolean;
  v_existing public.rides%rowtype;
  v_old record;
  v_home uuid;
  host public.rides%rowtype;
  required_party uuid;
  combined_start timestamptz;combined_end timestamptz;
  gap_override smallint;
begin
  select * into v_prop from public.proposals where id = p_proposal_id for update;
  if v_prop is null then raise exception 'proposal_not_found' using errcode = 'P0001'; end if;

  v_is_auto_apply := coalesce(current_setting('app.auto_applying_proposal', true), '') = 'on';
  if not v_is_auto_apply and not public.can_manage_week(v_prop.department_id, v_prop.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if v_prop.status <> 'accepted' then raise exception 'proposal_not_accepted' using errcode = 'P0001'; end if;

  select * into v_req from public.requests where id = v_prop.request_id for update;
  select home_destination_id into v_home from public.departments where id=v_prop.department_id;
  perform set_config('app.audit_reason', 'apply_proposal', true);
  perform set_config('app.system_status_transition', 'on', true);

  if v_prop.type = 'deny' then
    update public.requests set status = 'denied', status_reason = coalesce(v_prop.payload ->> 'reason', 'DENIED_BY_SADRAN')
    where id = v_prop.request_id;
  elsif v_prop.type = 'external' then
    update public.requests set status = 'external', status_reason = coalesce(v_prop.payload ->> 'reason', 'EXTERNAL')
    where id = v_prop.request_id;
  elsif v_prop.type = 'shift' then
    if v_prop.payload ? 'car_id' then
      select rd.* into v_existing from public.rides rd join public.ride_requests rr on rr.ride_id=rd.id
      where rr.request_id=v_req.id and rr.role='driver' and rd.status<>'cancelled' order by rd.starts_at limit 1 for update of rd;
      if v_req.trip_shape<>'round_trip' then raise exception 'one_way_requires_relay_assignment'; end if;
      if v_existing.id is not null then
        if exists(select 1 from public.ride_requests rr where rr.ride_id=v_existing.id and rr.request_id<>v_req.id) then raise exception 'shared_ride_requires_sadran'; end if;
        update public.rides set car_id=(v_prop.payload->>'car_id')::uuid,
          starts_at=coalesce((v_prop.payload->>'depart_at')::timestamptz,starts_at),
          ends_at=coalesce((v_prop.payload->>'return_at')::timestamptz,ends_at),
          is_pinned=true,pin_reason='PROPOSAL_APPLIED' where id=v_existing.id returning id into v_ride_id;
      else
        insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
        values(v_prop.department_id,v_prop.week_start,(v_prop.payload->>'car_id')::uuid,
          coalesce((v_prop.payload->>'depart_at')::timestamptz,v_req.depart_at),coalesce((v_prop.payload->>'return_at')::timestamptz,v_req.return_at),
          coalesce((v_prop.payload->>'origin_id')::uuid,v_home),coalesce((v_prop.payload->>'destination_id')::uuid,v_home),v_req.requester_id,
          case when public.is_week_public(v_prop.department_id,v_prop.week_start) then 'confirmed'::public.ride_status else 'draft'::public.ride_status end,
          true,'PROPOSAL_APPLIED',v_prop.created_by) returning id into v_ride_id;
        insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(v_ride_id,v_req.id,'driver','both','keep');
      end if;
      update public.requests set status='assigned',status_reason='PROPOSAL_APPLIED' where id=v_req.id;
      perform public.assert_ride_request_day(v_ride_id);
      perform public.assert_ride_seats_fit(v_ride_id);
      perform public.assert_car_chain((v_prop.payload->>'car_id')::uuid,v_prop.week_start);
      if v_existing.car_id is not null and v_existing.car_id<>(v_prop.payload->>'car_id')::uuid then perform public.assert_car_chain(v_existing.car_id,v_prop.week_start); end if;
    else
      update public.requests set
        depart_at = coalesce((v_prop.payload ->> 'depart_at')::timestamptz, depart_at),
        return_at = coalesce((v_prop.payload ->> 'return_at')::timestamptz, return_at),
        trip_shape = coalesce((v_prop.payload ->> 'trip_shape')::public.trip_shape, trip_shape),
        needs_car_at_destination = coalesce((v_prop.payload ->> 'needs_car_at_destination')::boolean, needs_car_at_destination),
        status = 'submitted', status_reason = 'PROPOSAL_APPLIED_PENDING_ASSIGNMENT'
      where id = v_prop.request_id;
    end if;
  elsif v_prop.type = 'merge' then
    if not exists(select 1 from public.proposal_parties where proposal_id=v_prop.id and profile_id=v_req.requester_id and response='accepted')
      or exists(select 1 from public.proposal_parties where proposal_id=v_prop.id and response<>'accepted') then raise exception 'proposal_consent_required'; end if;
    if v_prop.payload ? 'request_fingerprint' and v_prop.payload->>'request_fingerprint' is distinct from public.merge_request_fingerprint(v_req.id) then perform public.raise_stale_version(); end if;
    for host in select * from public.rides where id in(select (value->>'ride_id')::uuid from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]'))) order by id for update loop
      if host.department_id<>v_prop.department_id or host.week_start<>v_prop.week_start or host.status='cancelled' then raise exception 'ride_not_found'; end if;
      if v_prop.payload ? 'host_versions' and host.version is distinct from (v_prop.payload->'host_versions'->>host.id::text)::int then perform public.raise_stale_version(); end if;
      for required_party in select host.driver_id where host.driver_id is not null union select q.requester_id from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=host.id loop
        if not exists(select 1 from public.proposal_parties where proposal_id=v_prop.id and profile_id=required_party and response='accepted') then raise exception 'proposal_consent_required'; end if;
      end loop;
    end loop;
    if exists(select 1 from jsonb_each_text(coalesce(v_prop.payload->'source_versions','{}')) expected left join public.rides r on r.id=expected.key::uuid
      where r.version is distinct from expected.value::int or r.status='cancelled') then perform public.raise_stale_version(); end if;
    -- Replace the request's prior solo assignment; do not leave a duplicate driver leg.
    for v_old in select rd.* from public.rides rd join public.ride_requests rr on rr.ride_id=rd.id
      where rr.request_id=v_req.id and rd.status<>'cancelled' and not exists(
        select 1 from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) desired_leg(value) where (desired_leg.value->>'ride_id')::uuid=rd.id
      ) order by rd.id for update of rd loop
      if v_old.driver_id=v_req.requester_id or (v_old.needs_driver and not exists(select 1 from public.ride_requests where ride_id=v_old.id and request_id<>v_req.id)) then
        if exists(select 1 from public.ride_requests where ride_id=v_old.id and request_id<>v_req.id) or v_old.origin_id<>v_old.destination_id then raise exception 'shared_ride_requires_sadran'; end if;
        update public.rides set status='cancelled',cancelled_at=now(),cancelled_by=v_req.requester_id,cancel_reason='MERGED_BY_CONSENT' where id=v_old.id;
      end if;
      delete from public.ride_requests where ride_id=v_old.id and request_id=v_req.id;
      perform public.assert_car_chain(v_old.car_id,v_old.week_start);
    end loop;
    for host in select * from public.rides where id in(select (value->>'ride_id')::uuid from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]'))) order by id for update loop
      combined_start:=least(host.starts_at,coalesce((v_prop.payload->>'starts_at')::timestamptz,host.starts_at));
      combined_end:=greatest(host.ends_at,coalesce((v_prop.payload->>'ends_at')::timestamptz,host.ends_at));
      gap_override:=host.turnaround_override_minutes;
      if coalesce((v_prop.payload->>'allow_tight_turnaround')::boolean,false) then
        gap_override:=public.prepare_manual_ride_window(host.car_id,host.week_start,combined_start,combined_end,host.id);
      end if;
      update public.rides set starts_at=combined_start,ends_at=combined_end,turnaround_override_minutes=gap_override where id=host.id;
    end loop;
    v_has_driver_leg := false;
    for v_leg in select * from jsonb_array_elements(coalesce(v_prop.payload -> 'legs', '[]')) loop
      v_ride_id := (v_leg ->> 'ride_id')::uuid;
      insert into public.ride_requests (ride_id, request_id, role, leg, car_mode, detour_minutes)
      values (v_ride_id, v_prop.request_id, coalesce((v_leg ->> 'role')::public.ride_role, 'passenger'),
        coalesce((v_leg ->> 'leg')::public.ride_leg, 'both'), (v_leg ->> 'car_mode')::public.leg_car_mode,
        coalesce((v_prop.payload ->> 'detour_minutes')::smallint, 0))
      on conflict (ride_id, request_id, leg) do update set car_mode = excluded.car_mode;
      update public.rides set is_pinned = true, pin_reason = 'PROPOSAL_APPLIED' where id = v_ride_id;
      if (v_leg ->> 'role') = 'driver' then
        v_has_driver_leg := true;
      end if;
      perform public.assert_ride_request_day(v_ride_id);
      perform public.assert_ride_seats_fit(v_ride_id);
      perform public.assert_car_chain(r.car_id, r.week_start) from public.rides r where r.id = v_ride_id;
    end loop;
    update public.requests set status = (case when exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=v_req.id and r.needs_driver and r.status<>'cancelled') then 'waitlisted' when v_has_driver_leg then 'assigned' else 'merged' end)::public.request_status,
      status_reason = case when exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id where rr.request_id=v_req.id and r.needs_driver and r.status<>'cancelled') then 'UNMET_NEEDS_DRIVER' else 'PROPOSAL_APPLIED' end
    where id = v_prop.request_id;
  end if;

  perform set_config('app.system_status_transition', 'off', true);

  update public.proposals set status = 'applied', applied_at = now(), applied_ride_id = v_ride_id where id = p_proposal_id;

  perform public.enqueue_notification(v_req.requester_id, 'outcome_changed', v_prop.department_id, v_prop.week_start,
    '{}'::jsonb, jsonb_build_object('request_id', v_prop.request_id), format('outcome_changed:%s:%s', v_prop.request_id, p_proposal_id));

  if v_prop.type='merge' then
    perform public.enqueue_notification(pp.profile_id,'outcome_changed',v_prop.department_id,v_prop.week_start,'{}',jsonb_build_object('request_id',v_req.id,'ride_id',v_ride_id),format('merge_applied:%s:%s',v_prop.id,pp.profile_id))
    from public.proposal_parties pp where pp.proposal_id=v_prop.id and pp.profile_id<>v_req.requester_id;
  end if;
  return v_ride_id;
end;
$$;

