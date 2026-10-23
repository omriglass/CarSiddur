-- R5B3 re-check (owner 2026-10-23: no notification bursts): an accepted proposal withdrawn as stale told the member twice
-- ("the request is back on the waiting list, the ride still needs a driver" and "the proposal is no longer possible") and
-- the Sadran three times. proposal_system_withdraw already tells both; while it withdraws, the accepted-withdrawn
-- trigger now stays quiet towards whoever it tells (`app.system_withdraw_notifies`: 'all' = members and Sadran, 'sadran'
-- = the Sadran only). A Sadran's own withdrawal of an accepted proposal still sends the trigger's notices.
create or replace function public.proposal_system_withdraw("p_proposal_id" "uuid", "p_variant" "text", "p_reason" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_p public.proposals%rowtype; v_to uuid; v_sadranim uuid[]; v_rv jsonb;
begin
  select * into v_p from public.proposals where id = p_proposal_id for update;
  if not found or v_p.status not in ('sent','accepted') then return; end if;
  perform set_config('app.audit_reason', 'proposal_system_withdraw', true);
  -- R5B3 noise: this function tells the Sadran (and, for these variants, the members who accepted) itself, so the
  -- accepted-withdrawn trigger's "still needs a driver" notices would be a second notice about the same thing.
  perform set_config('app.system_withdraw_notifies', case when p_variant in ('withdrawn_stale', 'withdrawn_ride', 'withdrawn_dependency') then 'all' else 'sadran' end, true);
  update public.proposals set status = 'withdrawn', token_hash = encode(digest(public.generate_token(), 'sha256'), 'hex')
  where id = p_proposal_id;
  perform set_config('app.system_withdraw_notifies', '', true);
  update public.proposal_parties set token_hash = encode(digest(public.generate_token(), 'sha256'), 'hex')
  where proposal_id = p_proposal_id;
  select coalesce(array_agg(s.profile_id), '{}') into v_sadranim from public.sadranim_of(v_p.department_id, v_p.week_start) as s(profile_id);
  -- REQ §13.103 R3B1: the members who accepted are told their answer no longer leads anywhere.
  if p_variant in ('withdrawn_stale', 'withdrawn_ride', 'withdrawn_dependency') then
    for v_to in select pp.profile_id from public.proposal_parties pp
                where pp.proposal_id = v_p.id and pp.response = 'accepted'
                  and pp.profile_id is distinct from v_p.created_by and not (pp.profile_id = any(v_sadranim)) loop
      v_rv := public.proposal_reader_vars(v_p.id, v_to);
      perform public.enqueue_notification(v_to, 'outcome_changed', v_p.department_id, v_p.week_start,
        jsonb_build_object('route', coalesce(v_rv->'vars'->>'route', ''), 'day', coalesce(v_rv->'vars'->>'day', '')),
        jsonb_build_object('variant', case when p_variant = 'withdrawn_dependency' then 'proposal_withdrawn_dependency'
          else 'proposal_withdrawn_stale' end, 'proposal_id', v_p.id, 'request_id', v_p.request_id),
        format('proposal_withdrawn_member:%s:%s', v_p.id, v_to));
    end loop;
  end if;
  for v_to in
    select x from (select v_p.created_by as x where v_p.created_by is not null and v_p.created_via = 'sadran'
                   union select unnest(v_sadranim)) y
    where x is not null
  loop
    perform public.enqueue_notification(v_to, 'proposal_answered', v_p.department_id, v_p.week_start,
      '{}'::jsonb, jsonb_build_object('variant', p_variant, 'proposal_id', v_p.id, 'request_id', v_p.request_id)
        || case when p_reason is null then '{}'::jsonb else jsonb_build_object('reason', p_reason) end,
      format('proposal_withdrawn:%s:%s', v_p.id, v_to));
  end loop;
end $$;



create or replace function public.proposals_accepted_withdrawn_notice() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare r record; v_to uuid; v_route text; v_day text; v_names text;
begin
  for r in
    select rd.id as ride_id, rd.department_id, rd.week_start, rd.starts_at
    from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
    where rr.request_id = new.request_id and rd.status <> 'cancelled' and rd.needs_driver
  loop
    v_route := coalesce(public.request_route_label(new.request_id), '');
    v_day := public.day_date_label(r.starts_at);
    select coalesce(p.full_name, '') into v_names from public.requests q join public.profiles p on p.id = q.requester_id where q.id = new.request_id;
    select q.requester_id into v_to from public.requests q where q.id = new.request_id;
    if v_to is not null and coalesce(current_setting('app.system_withdraw_notifies', true), '') <> 'all' then
      perform public.enqueue_notification(v_to, 'outcome_changed', r.department_id, r.week_start,
        jsonb_build_object('route', v_route, 'day', v_day),
        jsonb_build_object('variant', 'ride_still_needs_driver', 'ride_id', r.ride_id, 'request_id', new.request_id, 'proposal_id', new.id),
        format('ride_still_needs_driver:%s:%s', new.id, v_to));
    end if;
    perform public.enqueue_notification(s.profile_id, 'outcome_changed', r.department_id, r.week_start,
      jsonb_build_object('route', v_route, 'day', v_day, 'names', coalesce(v_names, '')),
      jsonb_build_object('variant', 'ride_still_needs_driver_sadran', 'ride_id', r.ride_id, 'request_id', new.request_id, 'proposal_id', new.id),
      format('ride_still_needs_driver_sadran:%s:%s', new.id, s.profile_id))
    from public.sadranim_of(r.department_id, r.week_start) as s(profile_id)
    where s.profile_id is distinct from (select auth.uid())
      and coalesce(current_setting('app.system_withdraw_notifies', true), '') = '';
  end loop;
  return new;
end $$;


