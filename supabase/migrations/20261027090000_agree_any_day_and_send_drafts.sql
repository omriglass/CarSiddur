-- REQ §13.138 (a, b, d): "דיברת עם X על השינוי?" — "כן, כבר סיכמנו" applies a Sadran's draft on any day (published or
-- not) with no proposal, and "שלח את כל ההצעות" sends the week's drafts in one go. Replaces REQ §13.123: the
-- department setting `proposals_offline` is no longer read (column kept, deprecated).

-- `app.defer_proposal_apply = 'on'` lets agree_proposal_offline() record every party's answer first and apply the
-- proposal itself afterwards (with its own notification rule), instead of the roll-up trigger applying it mid-way.
create or replace function public.maybe_apply_accepted_proposal(p_proposal_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_prop record; v_auto boolean; v_msg text;
  -- Restore the caller's flags after a failed apply, never force them off (CLAUDE.md, code review 2026-09-24).
  v_prev_auto text := coalesce(current_setting('app.auto_applying_proposal', true), '');
  v_prev_sst text := coalesce(current_setting('app.system_status_transition', true), '');
  v_prev_applying text := coalesce(current_setting('app.applying_proposal', true), '');
begin
  if coalesce(current_setting('app.defer_proposal_apply', true), '') = 'on' then
    return;
  end if;
  select * into v_prop from public.proposals where id = p_proposal_id;
  if v_prop is null or v_prop.status <> 'accepted' then
    return;
  end if;
  select auto_apply_accepted_proposals into v_auto from public.department_settings where department_id = v_prop.department_id;
  if v_auto then
    -- REQ §13.102 R2B1: the member's answer always stands. If the proposal can no longer be applied (the ride moved,
    -- a turnaround or seat limit now fails, ...) it is withdrawn and the Sadran is told, instead of the answer failing.
    begin
      perform set_config('app.auto_applying_proposal', 'on', true);
      perform public.apply_proposal(p_proposal_id);
      perform set_config('app.auto_applying_proposal', v_prev_auto, true);
    exception when others then
      v_msg := sqlerrm;
      perform set_config('app.auto_applying_proposal', v_prev_auto, true);
      perform set_config('app.system_status_transition', v_prev_sst, true);
      perform set_config('app.applying_proposal', v_prev_applying, true);
      perform public.proposal_system_withdraw(p_proposal_id, 'withdrawn_stale', v_msg);
    end;
  end if;
end;
$$;

-- REQ §13.138 (a, b): "כן, כבר סיכמנו". Every party is recorded as having accepted and the proposal is applied at once,
-- whatever `auto_apply_accepted_proposals` says. Nobody gets a proposal or an answer notice. On a day that is not yet
-- public the apply is silent too (members learn it at publish, as before); on a published/live day the apply's ordinary
-- "your ride changed" notices go out (REQ §13.138 c holds them when the change was made on the board). A proposal that
-- can no longer be applied is withdrawn silently and the reason returned to the Sadran.
create or replace function public.agree_proposal_offline(p_proposal_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p public.proposals%rowtype;
  v_req public.requests%rowtype;
  v_prev_supp text := coalesce(current_setting('app.suppress_notifications', true), '');
  v_prev_reason text := coalesce(current_setting('app.suppressed_reason', true), '');
  v_prev_defer text := coalesce(current_setting('app.defer_proposal_apply', true), '');
  v_prev_auto text := coalesce(current_setting('app.auto_applying_proposal', true), '');
  v_prev_sst text := coalesce(current_setting('app.system_status_transition', true), '');
  v_prev_applying text := coalesce(current_setting('app.applying_proposal', true), '');
  v_day date; v_public boolean := false; v_party record; v_status public.proposal_status; v_reason text;
begin
  select * into v_p from public.proposals where id = p_proposal_id;
  if not found then raise exception 'proposal_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_p.department_id, v_p.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if v_p.status not in ('draft', 'sent') then raise exception 'proposal_not_answerable' using errcode = 'P0001'; end if;
  select * into v_req from public.requests where id = v_p.request_id;
  -- The request's own legs and any shifted times: is any of those days already public?
  for v_day in
    select distinct (t at time zone 'Asia/Jerusalem')::date from unnest(array[
      v_req.depart_at, v_req.return_at,
      nullif(v_p.payload ->> 'depart_at', '')::timestamptz, nullif(v_p.payload ->> 'return_at', '')::timestamptz]) t
    where t is not null
  loop
    if public.is_day_public(v_p.department_id, v_p.week_start, v_day) then v_public := true; end if;
  end loop;

  perform set_config('app.suppress_notifications', 'on', true);
  perform set_config('app.suppressed_reason', '', true);
  perform set_config('app.defer_proposal_apply', 'on', true);
  if v_p.status = 'draft' then
    perform public.send_proposal(p_proposal_id);
  end if;
  for v_party in select profile_id from public.proposal_parties
                 where proposal_id = p_proposal_id and response = 'pending' order by id loop
    perform public.record_answer_on_behalf(p_proposal_id, v_party.profile_id, true, null);
  end loop;
  perform set_config('app.defer_proposal_apply', v_prev_defer, true);

  select status into v_status from public.proposals where id = p_proposal_id;
  if v_status = 'accepted' then
    if v_public then perform set_config('app.suppress_notifications', v_prev_supp, true); end if;
    begin
      perform set_config('app.auto_applying_proposal', 'on', true);
      perform public.apply_proposal(p_proposal_id);
      perform set_config('app.auto_applying_proposal', v_prev_auto, true);
    exception when others then
      v_reason := sqlerrm;
      perform set_config('app.auto_applying_proposal', v_prev_auto, true);
      perform set_config('app.system_status_transition', v_prev_sst, true);
      perform set_config('app.applying_proposal', v_prev_applying, true);
      -- Nobody was ever asked, so nobody is told the answer no longer stands: the Sadran gets the reason on the spot.
      perform set_config('app.suppress_notifications', 'on', true);
      perform public.proposal_system_withdraw(p_proposal_id, 'withdrawn_stale', v_reason);
    end;
  end if;
  v_reason := coalesce(v_reason, nullif(current_setting('app.suppressed_reason', true), ''));
  perform set_config('app.suppress_notifications', v_prev_supp, true);
  perform set_config('app.suppressed_reason', v_prev_reason, true);

  select status into v_status from public.proposals where id = p_proposal_id;
  if v_status = 'withdrawn' then
    return jsonb_build_object('status', 'withdrawn_stale', 'reason', v_reason);
  end if;
  return jsonb_build_object('status', 'applied', 'proposal_status', v_status);
end $$;

-- REQ §13.138 (d): "שלח את כל ההצעות" — sends every Sadran draft of the week whose request starts on one of `p_days`
-- (null = every day), oldest first. A draft that replaces the request's sent, unanswered proposal replaces it, as the
-- composer does. One draft that cannot be sent does not stop the others: each result row says `ok` or the `error` code.
-- Returns `[{proposal_id, day, ok, party_tokens?, car_conflicts?, error?}]`; the party tokens let the board offer the
-- optional WhatsApp messages afterwards.
create or replace function public.send_draft_proposals(p_department_id uuid, p_week_start date, p_days date[] default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p record;
  v_prev public.proposals%rowtype;
  v_res jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  for v_p in
    select p.id, p.request_id, (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date as day
    from public.proposals p
    join public.requests q on q.id = p.request_id
    where p.department_id = p_department_id and p.week_start = p_week_start
      and p.status = 'draft' and p.created_via = 'sadran'
    order by p.created_at, p.id
  loop
    continue when p_days is not null and not (v_p.day = any(p_days));
    select * into v_prev from public.proposals where request_id = v_p.request_id and status = 'sent' and id <> v_p.id;
    begin
      v_res := public.send_proposal(v_p.id, '{}'::public.notification_channel[], v_prev.id, v_prev.version);
      v_out := v_out || jsonb_build_array(jsonb_build_object('proposal_id', v_p.id, 'day', v_p.day, 'ok', true,
        'party_tokens', coalesce(v_res -> 'party_tokens', '{}'::jsonb), 'car_conflicts', coalesce(v_res -> 'car_conflicts', '[]'::jsonb)));
    exception when others then
      v_out := v_out || jsonb_build_array(jsonb_build_object('proposal_id', v_p.id, 'day', v_p.day, 'ok', false, 'error', sqlerrm));
    end;
  end loop;
  return v_out;
end $$;

revoke all on function public.send_draft_proposals(uuid, date, date[]) from public, anon;
grant execute on function public.send_draft_proposals(uuid, date, date[]) to authenticated;

comment on column public.department_settings.proposals_offline is
  'Deprecated (REQ §13.138, 2026-10-19): no longer read. "כן, כבר סיכמנו" (agree_proposal_offline) works on every day.';
