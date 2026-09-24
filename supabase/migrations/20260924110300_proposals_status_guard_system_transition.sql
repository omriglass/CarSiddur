-- Code review 2026-09-24 R12 follow-up (docs/TODO.md): 20260924110100 made
-- requests_status_guard() refuse a status change unless it comes from the requester, a
-- manager of the request's week, or a system transition. proposals_status_guard() moves the
-- proposal's request to `proposed` on send and back to `previous_status` on
-- decline/expire/withdraw — a system transition that it never flagged. With a signed-in
-- *second party* declining (answer_proposal → proposal_parties_roll_up → this trigger), the
-- actor is neither the requester nor a manager, so the decline raised `not_authorized`.
-- Flag the two request updates, restoring whatever value the caller had set (an outer
-- apply/withdraw may already have it 'on').
--
-- Full `create or replace` (R10 convention); body otherwise identical to the live definition.

create or replace function public.proposals_status_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  elsif old.status in ('accepted','declined','expired','withdrawn','applied') and new.status <> 'applied' then
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
  elsif new.status in ('declined','expired','withdrawn') then
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = new.previous_status where id = new.request_id;
    perform set_config('app.system_status_transition', v_prev_flag, true);
  end if;

  return new;
end;
$$;
