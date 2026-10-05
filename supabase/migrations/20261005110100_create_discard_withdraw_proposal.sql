-- REQ §13.94 (board drafts, plan §1): Sadran-only discard of a draft proposal and withdrawal of a
-- sent/accepted one. Both end in status `withdrawn`; proposals_status_guard restores the request's
-- previous status for sent/accepted (not for drafts, which never changed it). Tokens are rotated
-- so a `/p/:token` link stops working; no member notification is enqueued.

create or replace function public.discard_proposal(p_proposal_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_p public.proposals%rowtype;
begin
  select * into v_p from public.proposals where id = p_proposal_id for update;
  if not found then raise exception 'proposal_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_p.department_id, v_p.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if v_p.status <> 'draft' then raise exception 'proposal_not_draft' using errcode = 'P0001'; end if;
  perform set_config('app.audit_reason', 'discard_proposal', true);
  update public.proposals set status = 'withdrawn' where id = p_proposal_id;
end;
$$;

create or replace function public.withdraw_proposal(p_proposal_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
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
  update public.proposals
  set status = 'withdrawn', token_hash = encode(digest(public.generate_token(), 'sha256'), 'hex')
  where id = p_proposal_id;
  update public.proposal_parties
  set token_hash = encode(digest(public.generate_token(), 'sha256'), 'hex')
  where proposal_id = p_proposal_id;
end;
$$;

revoke all on function public.discard_proposal(uuid) from public, anon;
revoke all on function public.withdraw_proposal(uuid) from public, anon;
grant execute on function public.discard_proposal(uuid) to authenticated;
grant execute on function public.withdraw_proposal(uuid) to authenticated;

