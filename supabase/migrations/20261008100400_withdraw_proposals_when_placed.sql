-- REQ §13.102 R2B21: a pending "no car" proposal (external / deny) is moot the moment the member gets a ride or joins
-- a contested waiting-list group. It is withdrawn (the Sadran is told once, `withdrawn_placed`); an unsent draft is
-- discarded silently. The proposals status guard only restores the request's previous status while the request is still
-- `proposed`, so a status the placement already set is never overwritten.
create or replace function public.proposals_status_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prev_flag text := coalesce(current_setting('app.system_status_transition', true), 'off');
begin
  if tg_op = 'INSERT' or new.status = old.status then
    return new;
  end if;

  if old.status = 'draft' and new.status not in ('sent','withdrawn') then
    raise exception 'invalid_proposal_transition' using errcode = 'P0001';
  elsif old.status = 'sent' and new.status not in ('accepted','declined','expired','withdrawn') then
    raise exception 'invalid_proposal_transition' using errcode = 'P0001';
  elsif old.status in ('accepted','declined','expired','withdrawn','applied') and new.status <> 'applied'
and not (old.status = 'accepted' and new.status = 'withdrawn') then
    raise exception 'invalid_proposal_transition' using errcode = 'P0001';
  elsif old.status = 'applied' then
    raise exception 'invalid_proposal_transition' using errcode = 'P0001';
  elsif new.status = 'applied' and old.status <> 'accepted' then
    raise exception 'invalid_proposal_transition' using errcode = 'P0001';
  end if;

  if new.status = 'sent' then
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'proposed' where id = new.request_id;
    perform set_config('app.system_status_transition', v_prev_flag, true);
  elsif new.status in ('declined','expired','withdrawn') and old.status <> 'draft' then
    -- A draft never moved its request out of its own status (only `send_proposal` does), so
    -- discarding one must not "restore" a possibly stale previous_status. Likewise a request that is no
    -- longer `proposed` (it was placed, withdrawn, ...) keeps the status something else gave it.
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = new.previous_status where id = new.request_id and status = 'proposed';
    perform set_config('app.system_status_transition', v_prev_flag, true);
  end if;

  return new;
end;
$$;

create or replace function public.withdraw_open_external_proposals() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_p record; v_skip text := coalesce(nullif(current_setting('app.applying_proposal', true), ''), '');
begin
  for v_p in
    select p.id, p.status from public.proposals p
    where p.request_id = new.request_id and p.type in ('external', 'deny')
      and p.status in ('draft', 'sent', 'accepted') and p.id::text <> v_skip
    order by p.id
  loop
    if v_p.status = 'draft' then
      perform set_config('app.audit_reason', 'withdraw_open_external_proposals', true);
      update public.proposals set status = 'withdrawn' where id = v_p.id;
    else
      perform public.proposal_system_withdraw(v_p.id, 'withdrawn_placed');
    end if;
  end loop;
  return new;
end $$;
revoke all on function public.withdraw_open_external_proposals() from public;
grant execute on function public.withdraw_open_external_proposals() to service_role;

drop trigger if exists ride_requests_withdraw_external on public.ride_requests;
create trigger ride_requests_withdraw_external after insert on public.ride_requests
  for each row execute function public.withdraw_open_external_proposals();

drop trigger if exists waitlist_members_withdraw_external on public.waitlist_group_members;
create trigger waitlist_members_withdraw_external after insert on public.waitlist_group_members
  for each row execute function public.withdraw_open_external_proposals();
