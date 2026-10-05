-- REQ §13.100 (QA run 1, QB9 + QB15): proposals never go stale silently.
--  * a sent/accepted proposal whose host ride was cancelled/replaced, or whose request was edited, is
--    withdrawn by the system and the Sadran is told (proposal_answered variants withdrawn_ride / withdrawn_edit);
--  * an answered / withdrawn / expired / applied proposal is no longer pending for any party: its
--    proposal_received inbox notifications are marked read;
--  * when a party declines, every other party (driver / host / passengers) gets proposal_answered.

insert into public.notification_templates(event,channel,variant,title,body,default_title,default_body)
select 'proposal_answered', channel, t.variant, t.title, t.body, t.title, t.body
from (values
  ('withdrawn_ride', 'ההצעה ל{{firstName}} בוטלה', '{{destination}}, יום {{day}} — הנסיעה שהוצעה השתנתה או בוטלה'),
  ('withdrawn_edit', 'ההצעה ל{{firstName}} בוטלה', '{{destination}}, יום {{day}} — הבקשה שונתה'),
  ('declined_party', '{{firstName}} דחה/תה את ההצעה', '{{destination}}, יום {{day}} — ההצעה בוטלה')
) as t(variant, title, body)
cross join unnest(array['inbox','push']::public.notification_channel[]) channel
on conflict (event,channel,(coalesce(variant,''))) do update set title=excluded.title,body=excluded.body,default_title=excluded.default_title,default_body=excluded.default_body;

-- Internal: withdraw a live proposal because the world changed under it, and tell the Sadran.
create or replace function public.proposal_system_withdraw(p_proposal_id uuid, p_variant text) returns void
    language plpgsql security definer
    set search_path = public, pg_temp
    as $$
declare v_p public.proposals%rowtype; v_to uuid;
begin
  select * into v_p from public.proposals where id = p_proposal_id for update;
  if not found or v_p.status not in ('sent','accepted') then return; end if;
  perform set_config('app.audit_reason', 'proposal_system_withdraw', true);
  update public.proposals set status = 'withdrawn', token_hash = encode(digest(public.generate_token(), 'sha256'), 'hex')
  where id = p_proposal_id;
  update public.proposal_parties set token_hash = encode(digest(public.generate_token(), 'sha256'), 'hex')
  where proposal_id = p_proposal_id;
  for v_to in
    select x from (select v_p.created_by as x where v_p.created_by is not null and v_p.created_via = 'sadran'
                   union select s.profile_id from public.sadranim_of(v_p.department_id, v_p.week_start) as s(profile_id)) y
    where x is not null
  loop
    perform public.enqueue_notification(v_to, 'proposal_answered', v_p.department_id, v_p.week_start,
      '{}'::jsonb, jsonb_build_object('variant', p_variant, 'proposal_id', v_p.id, 'request_id', v_p.request_id),
      format('proposal_withdrawn:%s:%s', v_p.id, v_to));
  end loop;
end $$;

-- A ride that is cancelled (replaced, merged away, driver cancelled ...) takes the proposals hosted on it with it.
create or replace function public.rides_withdraw_proposals() returns trigger
    language plpgsql security definer
    set search_path = public, pg_temp
    as $$
declare v_id uuid; v_skip text := coalesce(nullif(current_setting('app.applying_proposal', true), ''), '');
begin
  for v_id in
    select p.id from public.proposals p
    where p.status in ('sent','accepted') and p.id::text <> v_skip
      and (p.ride_id = new.id or (p.payload -> 'host_versions') ? new.id::text)
    order by p.id
  loop
    perform public.proposal_system_withdraw(v_id, 'withdrawn_ride');
  end loop;
  return new;
end $$;

drop trigger if exists rides_withdraw_proposals on public.rides;
create trigger rides_withdraw_proposals after update of status on public.rides
  for each row when (new.status = 'cancelled' and old.status is distinct from 'cancelled')
  execute function public.rides_withdraw_proposals();

-- An edit of the request (member or Sadran, not the system applying a proposal) invalidates what was offered.
create or replace function public.requests_withdraw_proposals() returns trigger
    language plpgsql security definer
    set search_path = public, pg_temp
    as $$
declare
  v_id uuid; v_skip text := coalesce(nullif(current_setting('app.applying_proposal', true), ''), '');
  v_excl text[] := array['status','status_reason','version','updated_at','changed_since_solve'];
begin
  if coalesce(current_setting('app.system_status_transition', true), 'off') = 'on' then return new; end if;
  if (to_jsonb(new) - v_excl) is not distinct from (to_jsonb(old) - v_excl) then return new; end if;
  for v_id in
    select p.id from public.proposals p
    where p.request_id = new.id and p.status in ('sent','accepted') and p.id::text <> v_skip order by p.id
  loop
    perform public.proposal_system_withdraw(v_id, 'withdrawn_edit');
  end loop;
  return new;
end $$;

drop trigger if exists requests_withdraw_proposals on public.requests;
create trigger requests_withdraw_proposals after update on public.requests
  for each row execute function public.requests_withdraw_proposals();

-- Once a proposal is settled it is not pending for anyone.
create or replace function public.proposals_clear_inbox() returns trigger
    language plpgsql security definer
    set search_path = public, pg_temp
    as $$
begin
  update public.notifications set read_at = now()
  where event = 'proposal_received' and read_at is null and data ->> 'proposal_id' = new.id::text;
  return new;
end $$;

drop trigger if exists proposals_clear_inbox on public.proposals;
create trigger proposals_clear_inbox after update of status on public.proposals
  for each row when (new.status in ('accepted','declined','expired','withdrawn','applied') and old.status is distinct from new.status)
  execute function public.proposals_clear_inbox();

create or replace function public.proposal_parties_roll_up() returns trigger
    language plpgsql security definer
    set search_path = public, pg_temp
    as $$
declare
  v_total int; v_accepted int; v_declined int; v_status public.proposal_status;
  v_prop record;
  v_new_status public.proposal_status;
begin
  -- the responder's own offer is handled
  update public.notifications set read_at = now()
  where recipient_id = new.profile_id and event = 'proposal_received' and read_at is null
    and data ->> 'proposal_id' = new.proposal_id::text;
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

    if v_prop.created_by is not null then
      perform public.enqueue_notification(v_prop.created_by, 'proposal_answered', v_prop.department_id, v_prop.week_start,
        '{}'::jsonb, jsonb_build_object('variant', v_new_status::text, 'proposal_id', v_prop.id),
        format('proposal_answered:%s:%s', v_prop.id, v_prop.created_by));
    else
      perform public.enqueue_notification(s.profile_id, 'proposal_answered', v_prop.department_id, v_prop.week_start,
        '{}'::jsonb, jsonb_build_object('variant', v_new_status::text, 'proposal_id', v_prop.id),
        format('proposal_answered:%s:%s', v_prop.id, s.profile_id))
      from public.sadranim_of(v_prop.department_id, v_prop.week_start) as s(profile_id);
    end if;

    -- QB15: a decline is news for the other parties too (driver, host, fellow passengers).
    if v_new_status = 'declined' then
      perform public.enqueue_notification(pp.profile_id, 'proposal_answered', v_prop.department_id, v_prop.week_start,
        '{}'::jsonb, jsonb_build_object('variant', 'declined_party', 'proposal_id', v_prop.id, 'request_id', v_prop.request_id),
        format('proposal_answered:%s:%s', v_prop.id, pp.profile_id))
      from public.proposal_parties pp
      where pp.proposal_id = v_prop.id and pp.profile_id <> new.profile_id
        and pp.profile_id is distinct from v_prop.created_by;
    end if;

    if v_new_status = 'accepted' then
      perform public.maybe_apply_accepted_proposal(v_prop.id);
    end if;
  end if;

  return new;
end;
$$;
