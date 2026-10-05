-- REQ §13.94 (board drafts, plan §1): discarding a draft proposal (draft -> withdrawn) must
-- leave its request untouched. The guard used to write `previous_status` back on every
-- withdrawal, which for a draft (request never became `proposed`) could overwrite a status
-- the request reached after the draft was created. Sent/accepted withdrawals still restore, and accepted -> withdrawn is now a legal transition (withdraw_proposal).

CREATE OR REPLACE FUNCTION "public"."proposals_status_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
    -- discarding one must not "restore" a possibly stale previous_status.
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = new.previous_status where id = new.request_id;
    perform set_config('app.system_status_transition', v_prev_flag, true);
  end if;

  return new;
end;
$$;
