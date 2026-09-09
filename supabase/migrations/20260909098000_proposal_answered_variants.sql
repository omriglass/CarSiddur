-- Bug fix: proposal_answered rendered the raw proposal_status enum value inside a
-- {{answerVerb}} placeholder that had no translated counterpart — the notification title
-- mixed an untranslated English word into an otherwise-Hebrew sentence. answerVerb was
-- passed from SQL as the English enum value (proposal_status: accepted/declined) or the
-- literal 'expired', with no Hebrew translation anywhere (hard rule 3 forbids one in
-- function bodies). Follow the outcome_changed/ride_cancelled precedent
-- (20260909092000_notify_passengers_on_ride_cancellation.sql) instead: pass a `variant` in
-- `_data` and let notification_templates carry per-variant Hebrew copy; enqueue_notification
-- already selects on `coalesce(_data->>'variant', ...)` (20260909090000_add_notification_
-- default_url.sql), so no change to enqueue_notification itself is needed.
-- REQ §9; DATA_MODEL.md §3.11.

-- Reproduced verbatim from the live database (select pg_get_functiondef(...)), which matches
-- 20260907090900_proposals.sql per that file's own comment — only the two enqueue_notification
-- calls change: `answerVerb` moves out of vars and into `_data.variant` ('accepted'/'declined').
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

    -- `variant` selects the Hebrew copy in notification_templates (accepted/declined);
    -- `proposal_id` in `_data` lets notification_default_url() (20260909090000) link back
    -- to the Sadran's proposals list without a token.
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

    if v_new_status = 'accepted' then
      perform public.maybe_apply_accepted_proposal(v_prop.id);
    end if;
  end if;

  return new;
end;
$$;

-- Reproduced verbatim from the live database; only the enqueue_notification call changes:
-- `answerVerb` moves out of vars and into `_data.variant := 'expired'`.
create or replace function public.expire_proposals(_now timestamptz default now()) returns int
security definer set search_path=public,pg_temp language plpgsql as $$
declare v_count int:=0; request_row record; r record;
begin
  for request_row in select q.id from public.requests q where exists(
    select 1 from public.proposals p where p.request_id=q.id and p.status='sent' and p.expires_at<=_now
  ) order by q.id for update skip locked loop
    for r in update public.proposals set status='expired'
      where request_id=request_row.id and status='sent' and expires_at<=_now
      returning id,department_id,week_start,request_id,previous_status,created_by loop
      v_count:=v_count+1;
      perform public.enqueue_notification(r.created_by,'proposal_answered',r.department_id,r.week_start,
        '{}'::jsonb,jsonb_build_object('variant','expired','request_id',r.request_id),format('proposal_expired:%s',r.id));
    end loop;
  end loop;
  return v_count;
end $$;

-- proposal_answered: fallback (variant is null) copy, fixed to no longer reference
-- {{answerVerb}} (which was never a template placeholder — it silently rendered blank
-- once `render_notification_text` stripped the unresolved {{...}} token, or, since it *was*
-- resolved via `_vars`, rendered the raw enum text). Kept only as a defensive fallback; the
-- three variants below are what real traffic hits.
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'proposal_answered', channel, null,
  '{{firstName}} ענה/תה על ההצעה',
  '{{destination}}, {{day}} {{depart}}–{{return}}',
  '{{firstName}} ענה/תה על ההצעה',
  '{{destination}}, {{day}} {{depart}}–{{return}}'
from unnest(array['inbox', 'push']::public.notification_channel[]) as channel
on conflict (event, channel, coalesce(variant, '')) do update set
  title = excluded.title, body = excluded.body, default_title = excluded.default_title, default_body = excluded.default_body;

-- proposal_answered: accepted / declined / expired variants — this migration's fix.
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'proposal_answered', channel, t.variant, t.title, t.body, t.title, t.body
from (values
  ('accepted', '{{firstName}} אישר/ה את ההצעה', '{{destination}}, {{day}} {{depart}}–{{return}}'),
  ('declined', '{{firstName}} דחה/תה את ההצעה', '{{destination}}, {{day}} {{depart}}–{{return}}'),
  ('expired', 'ההצעה ל{{firstName}} פקעה', '{{destination}}, {{day}} {{depart}}–{{return}}')
) as t(variant, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as channel
on conflict (event, channel, coalesce(variant, '')) do update set
  title = excluded.title, body = excluded.body, default_title = excluded.default_title, default_body = excluded.default_body;

-- Backfill: the other rows changed in today's supabase/seed.sql (proposal_received, freed_slot,
-- claim_contested, waitlisted_request, and the outcome_changed/ride_cancelled variant) that
-- have no matching data migration yet. seed.sql only seeds fresh databases (CLAUDE.md
-- "Consistency decisions" #2), so any already-provisioned environment — this local DB
-- included — never picked up the new copy. `do update` (not `do nothing`) so it actually
-- lands here; admin customizations of these particular rows are not expected yet, this is a
-- same-day correction of demo/default copy, not a later admin override.
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select t.event::public.notification_event, ch, null, t.title, t.body, t.title, t.body
from (values
  ('proposal_received', 'הצעה מ{{sadranName}} לגבי {{destination}}', '{{day}} {{depart}}–{{return}} — {{proposalShort}}'),
  ('freed_slot', 'התפנה רכב ל{{destination}}', '{{car}}, {{day}} {{depart}}–{{return}}.'),
  ('claim_contested', '{{count}} חברים מבקשים את הרכב שהתפנה', '{{car}}, {{day}} {{depart}}–{{return}}.'),
  ('waitlisted_request', 'בקשה חדשה מ{{firstName}} ללא רכב פנוי', '{{destination}}, {{day}} {{depart}}–{{return}}.')
) as t(event, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do update set
  title = excluded.title, body = excluded.body, default_title = excluded.default_title, default_body = excluded.default_body;

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'outcome_changed', channel, 'ride_cancelled',
  '{{byName}} ביטל/ה נסיעה שהיית בה',
  '{{day}} {{depart}}–{{return}}, {{car}} ל{{destination}}.',
  '{{byName}} ביטל/ה נסיעה שהיית בה',
  '{{day}} {{depart}}–{{return}}, {{car}} ל{{destination}}.'
from unnest(array['inbox', 'push']::public.notification_channel[]) as channel
on conflict (event, channel, coalesce(variant, '')) do update set
  title = excluded.title, body = excluded.body, default_title = excluded.default_title, default_body = excluded.default_body;
