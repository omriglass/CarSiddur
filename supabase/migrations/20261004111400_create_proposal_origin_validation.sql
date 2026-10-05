-- O3 (REQ §13.93, ORIGINS_PLAN §3/§4): create_proposal() gains a light payload shape check for
-- the new `origin` type, the same way it already does for `merge`'s `legs` array -- the Sadran
-- UI (ui-dev follow-up) always sends `{ origin_id, car_id }`, straight from the solver's
-- `changeOrigin` suggestion. No other behaviour changes; full create-or-replace (hard rule 8).
create or replace function public.create_proposal(p_request_id uuid, p_ride_id uuid, p_type public.proposal_type,
  p_payload jsonb, p_reason_he text, p_party_profile_ids uuid[] default '{}'::uuid[], p_created_via text default 'sadran'::text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_req record;
  v_proposal_id uuid;
  v_token text;
  v_party uuid;
  host public.rides%rowtype;
  target_ids uuid[];
  required_parties uuid[];
  host_versions jsonb:='{}';
  source_versions jsonb:='{}';
  combined_start timestamptz;combined_end timestamptz;
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

  -- Owner decision (20260910098000): a proposal cannot be created for a day that is
  -- already published — that day's coordination happens directly, not through the app.
  -- "Ask to join" is exempt: it is filed by submit_request(), not composed by the Sadran,
  -- and still needs to reach the temporary car's owner even on a published/live day.
  if p_created_via <> 'ask_to_join'
     and public.is_day_public(v_req.department_id, v_req.week_start,
       (coalesce(v_req.depart_at, v_req.return_at) at time zone 'Asia/Jerusalem')::date)
  then
    raise exception 'proposal_day_public' using errcode = 'P0001';
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
      if not public.is_quarter_hour(combined_start)
        or not (public.is_quarter_hour(combined_end) or (combined_end at time zone 'Asia/Jerusalem')::time=time '23:59')
        or combined_end<=combined_start
        or (combined_end at time zone 'Asia/Jerusalem')::date<>(combined_start at time zone 'Asia/Jerusalem')::date
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
  elsif p_type='origin' then
    if p_created_via <> 'sadran' then raise exception 'not_authorized' using errcode = 'P0001'; end if;
    if nullif(p_payload->>'origin_id','') is null or nullif(p_payload->>'car_id','') is null then
      raise exception 'origin_proposal_requires_car_and_origin' using errcode = 'P0001';
    end if;
  end if;

  -- No timer any more: expires_at stays null until the proposal's day is
  -- published or has passed (expire_proposals(), 20260910090000, decides that).
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
$$;
