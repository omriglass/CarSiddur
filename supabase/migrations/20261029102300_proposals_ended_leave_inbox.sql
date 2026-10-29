-- O28-3 (owner 2026-10-28): a proposal that can no longer be answered leaves the inbox. When a proposal becomes
-- `withdrawn` or `expired`, its `proposal_received` notices are deleted for every party (their pending pushes go with
-- them: push_outbox.notification_id is `on delete cascade`), and so are held `proposal_received` notices carrying its
-- proposal_id (none are held today — _board_hold_applies() only holds outcome_changed / car_swapped /
-- waitlist_resolved; the held `outcome_changed` notices that carry a proposal_id are the "the proposal you accepted is
-- no longer valid" / "still needs a driver" notices, which stay). Before deleting, each party's
-- `offer_notice_opened` records whether the notice had been opened, for send_proposal()'s quiet replacement
-- (20261029102400). `accepted` / `declined` / `applied` keep today's mark-read.
-- Full definition of proposals_clear_inbox (the trigger already fires on all five statuses) plus a one-time cleanup
-- for proposals that are already withdrawn or expired.

create or replace function public.proposals_clear_inbox() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if new.status in ('withdrawn', 'expired') then
    update public.proposal_parties pp set offer_notice_opened = x.opened
    from (select n.recipient_id,
                 bool_or(n.read_at is not null and coalesce(n.data->>'cleared_by', '') <> 'system') as opened
          from public.notifications n
          where n.event = 'proposal_received' and n.data ->> 'proposal_id' = new.id::text
          group by n.recipient_id) x
    where pp.proposal_id = new.id and pp.profile_id = x.recipient_id;
    delete from public.notifications where event = 'proposal_received' and data ->> 'proposal_id' = new.id::text;
    delete from public.held_notices where event = 'proposal_received' and data ->> 'proposal_id' = new.id::text;
    return new;
  end if;
  update public.notifications set read_at = now(), data = coalesce(data, '{}'::jsonb) || jsonb_build_object('cleared_by', 'system')
  where event = 'proposal_received' and read_at is null and data ->> 'proposal_id' = new.id::text;
  return new;
end $$;

-- One-time cleanup: proposals already withdrawn or expired.
update public.proposal_parties pp set offer_notice_opened = x.opened
from (select p.id as proposal_id, n.recipient_id,
             bool_or(n.read_at is not null and coalesce(n.data->>'cleared_by', '') <> 'system') as opened
      from public.notifications n
      join public.proposals p on p.id::text = n.data ->> 'proposal_id'
      where n.event = 'proposal_received' and p.status in ('withdrawn', 'expired')
      group by p.id, n.recipient_id) x
where pp.proposal_id = x.proposal_id and pp.profile_id = x.recipient_id;

delete from public.notifications n
using public.proposals p
where n.event = 'proposal_received' and p.id::text = n.data ->> 'proposal_id' and p.status in ('withdrawn', 'expired');

delete from public.held_notices h
using public.proposals p
where h.event = 'proposal_received' and p.id::text = h.data ->> 'proposal_id' and p.status in ('withdrawn', 'expired');
