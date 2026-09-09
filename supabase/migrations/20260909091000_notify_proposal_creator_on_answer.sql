-- proposal_answered must reach the Sadran who actually sent the proposal, not every
-- Sadran of the week (a department can have several). Falls back to sadranim_of() only
-- when created_by is null (shouldn't happen — the column is not-null — but keeps the
-- notification firing instead of silently dropping if that ever changes).
-- REQ §9; DATA_MODEL.md §3.8, §3.11.
--
-- Reproduced verbatim from 20260907090900_proposals.sql (still the latest definition —
-- 20260907092000_fix_apply_proposal_auto_apply_authz.sql only mentions this function in a
-- comment, it does not redefine it) with the recipient changed. `expire_proposals()`
-- (latest in 20260907095600_replace_sent_proposals_explicitly.sql) already notifies
-- `created_by` and needs no change.
create or replace function public.proposal_parties_roll_up() returns trigger
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_total int; v_accepted int; v_declined int; v_status public.proposal_status;
  v_prop record;
  v_new_status public.proposal_status;
begin
  select status into v_status from public.proposals where id = new.proposal_id;
  if v_status <> 'sent' then
    return new;
  end if;
  select count(*), count(*) filter (where response = 'accepted'), count(*) filter (where response = 'declined')
    into v_total, v_accepted, v_declined
  from public.proposal_parties where proposal_id = new.proposal_id;

  if v_declined > 0 then
    v_new_status := 'declined';
  elsif v_accepted = v_total then
    v_new_status := 'accepted';
  end if;

  if v_new_status is not null then
    update public.proposals set status = v_new_status where id = new.proposal_id
    returning * into v_prop;

    -- vars are illustrative tokens, not Hebrew (hard rule 3) — the client renders copy.
    -- `proposal_id` in `_data` lets notification_default_url() (20260909090000) link back
    -- to the Sadran's proposals list without a token.
    if v_prop.created_by is not null then
      perform public.enqueue_notification(v_prop.created_by, 'proposal_answered', v_prop.department_id, v_prop.week_start,
        jsonb_build_object('answerVerb', v_new_status::text), jsonb_build_object('proposal_id', v_prop.id),
        format('proposal_answered:%s:%s', v_prop.id, v_prop.created_by));
    else
      perform public.enqueue_notification(s.profile_id, 'proposal_answered', v_prop.department_id, v_prop.week_start,
        jsonb_build_object('answerVerb', v_new_status::text), jsonb_build_object('proposal_id', v_prop.id),
        format('proposal_answered:%s:%s', v_prop.id, s.profile_id))
      from public.sadranim_of(v_prop.department_id, v_prop.week_start) as s(profile_id);
    end if;

    if v_new_status = 'accepted' then
      perform public.maybe_apply_accepted_proposal(v_prop.id);
    end if;
  end if;

  return new;
end;
$$;
