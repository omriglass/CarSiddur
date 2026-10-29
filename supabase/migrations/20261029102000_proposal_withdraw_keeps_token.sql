-- O28-1 (owner 2026-10-28): an old `/p/<token>` link says why it no longer works. Withdrawing a proposal no longer
-- overwrites its token hashes (proposals.token_hash, proposal_parties.token_hash), so `answer-proposal` can still find
-- a withdrawn proposal and answer `status: 'withdrawn'` (+ `superseded`) instead of "invalid link". Answering stays
-- impossible: answer_proposal() refuses every status but `sent` (proposal_not_answerable). housekeeping() still
-- scrambles ended proposals' tokens after 30 days (20261029102100).
-- Full definitions from schema-current.sql minus the token scramble.

create or replace function public.withdraw_proposal("p_proposal_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_p public.proposals%rowtype;
begin
  select * into v_p from public.proposals where id = p_proposal_id for update;
  if not found then raise exception 'proposal_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_p.department_id, v_p.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if v_p.status not in ('sent', 'accepted') then raise exception 'proposal_not_withdrawable' using errcode = 'P0001'; end if;
  perform set_config('app.audit_reason', 'withdraw_proposal', true);
  -- sent -> withdrawn; accepted -> withdrawn (both allowed by the guard, which restores the request).
  -- O28-1: the tokens are kept, so the members' links say "withdrawn" (answering refuses a non-`sent` proposal).
  update public.proposals set status = 'withdrawn' where id = p_proposal_id;
end;
$$;

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
  -- O28-1: the tokens are kept, so the members' links say "withdrawn" (answering refuses a non-`sent` proposal).
  update public.proposals set status = 'withdrawn' where id = p_proposal_id;
  perform set_config('app.system_withdraw_notifies', '', true);
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
