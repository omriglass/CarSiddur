-- REQ §13.123: the Sadran agreed a draft proposal with the members offline (WhatsApp) and marks it "agreed".
-- Runs the same path as a real send plus every party accepting (send_proposal -> record_answer_on_behalf ->
-- proposal_parties_roll_up -> maybe_apply_accepted_proposal), with every notification suppressed, so members
-- learn at publish. Only for days that are not published yet and only when department_settings.proposals_offline.
-- Errors (P0001): not_authorized, proposal_not_found, proposals_offline_disabled, proposal_day_published,
-- proposal_not_answerable (not draft/sent).
create or replace function public.agree_proposal_offline(p_proposal_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_p public.proposals%rowtype;
  v_req public.requests%rowtype;
  v_offline boolean;
  v_prev_supp text := coalesce(current_setting('app.suppress_notifications', true), '');
  v_prev_reason text := coalesce(current_setting('app.suppressed_reason', true), '');
  v_day date; v_party record; v_status public.proposal_status; v_reason text;
begin
  select * into v_p from public.proposals where id = p_proposal_id;
  if not found then raise exception 'proposal_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_p.department_id, v_p.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  select coalesce(proposals_offline, false) into v_offline from public.department_settings where department_id = v_p.department_id;
  if not coalesce(v_offline, false) then raise exception 'proposals_offline_disabled' using errcode = 'P0001'; end if;
  if v_p.status not in ('draft', 'sent') then raise exception 'proposal_not_answerable' using errcode = 'P0001'; end if;
  select * into v_req from public.requests where id = v_p.request_id;
  -- Every day the proposal touches must still be unpublished: the request's own legs and any shifted times.
  for v_day in
    select distinct (t at time zone 'Asia/Jerusalem')::date from unnest(array[
      v_req.depart_at, v_req.return_at,
      nullif(v_p.payload ->> 'depart_at', '')::timestamptz, nullif(v_p.payload ->> 'return_at', '')::timestamptz]) t
    where t is not null
  loop
    if public.is_day_public(v_p.department_id, v_p.week_start, v_day) then
      raise exception 'proposal_day_published' using errcode = 'P0001';
    end if;
  end loop;

  perform set_config('app.suppress_notifications', 'on', true);
  perform set_config('app.suppressed_reason', '', true);
  if v_p.status = 'draft' then
    perform public.send_proposal(p_proposal_id);
  end if;
  for v_party in select profile_id from public.proposal_parties
                 where proposal_id = p_proposal_id and response = 'pending' order by id loop
    perform public.record_answer_on_behalf(p_proposal_id, v_party.profile_id, true, null);
  end loop;
  v_reason := nullif(current_setting('app.suppressed_reason', true), '');
  perform set_config('app.suppress_notifications', v_prev_supp, true);
  perform set_config('app.suppressed_reason', v_prev_reason, true);

  select status into v_status from public.proposals where id = p_proposal_id;
  if v_status = 'withdrawn' then
    return jsonb_build_object('status', 'withdrawn_stale', 'reason', v_reason);
  end if;
  return jsonb_build_object('status', 'applied', 'proposal_status', v_status);
end $$;

revoke all on function public.agree_proposal_offline(uuid) from public;
grant execute on function public.agree_proposal_offline(uuid) to authenticated;
