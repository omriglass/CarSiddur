-- O29-2 (2) (owner 2026-10-29): returning a closed request ("החזר לרשימת ההמתנה", REQ §13.162 d) tells the member
-- once that it is back on the waiting list - but only when the closing notice may already have reached them (its inbox
-- entry was read, or one of its pushes was sent). A notice that was taken back before anyone saw it leaves nothing to
-- correct, so that restore stays silent.
insert into public.notification_templates(event,channel,variant,title,body,default_title,default_body)
select 'outcome_changed',channel,'request_restored',
  'הבקשה שלך חזרה לרשימת ההמתנה',
  '{{byName}} החזיר/ה את הבקשה שלך ליום {{day}} {{route}} לרשימת ההמתנה — ההודעה שהבקשה נסגרה נשלחה בטעות. נעדכן אם יימצא לך שיבוץ.',
  'הבקשה שלך חזרה לרשימת ההמתנה',
  '{{byName}} החזיר/ה את הבקשה שלך ליום {{day}} {{route}} לרשימת ההמתנה — ההודעה שהבקשה נסגרה נשלחה בטעות. נעדכן אם יימצא לך שיבוץ.'
from unnest(array['inbox','push']::public.notification_channel[]) channel
on conflict (event,channel,(coalesce(variant,''))) do update set title=excluded.title,body=excluded.body,default_title=excluded.default_title,default_body=excluded.default_body;

create or replace function public.restore_closed_request(p_request_id uuid, p_expected_version integer)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_req public.requests%rowtype; v_ids uuid[]; v_all uuid[]; v_removed int; v_held int; v_seen boolean; v_by text;
  v_prev text := coalesce(current_setting('app.system_status_transition', true), 'off');
begin
  select * into v_req from public.requests where id = p_request_id for update;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_req.department_id, v_req.week_start) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_expected_version is null or v_req.version <> p_expected_version then perform public.raise_stale_version(); end if;
  if v_req.status <> 'cancelled' or v_req.status_reason is distinct from 'CLOSED_BY_SADRAN' then
    raise exception 'request_not_closed' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.weeks where department_id = v_req.department_id and week_start = v_req.week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  perform set_config('app.audit_reason', 'restore_closed_request', true);

  -- the request and the series days closed with it, then the plan-B pair the cascade cancelled with them
  select coalesce(array_agg(q.id), '{}') into v_ids from public.requests q
  where (q.id = p_request_id or (v_req.series_id is not null and q.series_id = v_req.series_id))
    and q.status = 'cancelled' and q.status_reason = 'CLOSED_BY_SADRAN';
  select v_ids || coalesce(array_agg(q.id), '{}') into v_all from public.requests q
  where q.status = 'cancelled' and q.status_reason = 'PLAN_B_PAIR'
    and (q.plan_b_parent_id = any(v_ids) or q.id in (select x.plan_b_parent_id from public.requests x where x.id = any(v_ids)));

  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'waitlisted', status_reason = 'CLOSE_UNDONE' where id = any(v_all);
  perform set_config('app.system_status_transition', v_prev, true);

  -- Did the closing notice reach the member? (read in the inbox, or a push already sent)
  select exists (
    select 1 from public.notifications n
    where n.event = 'outcome_changed' and n.data ->> 'variant' in ('request_closed', 'request_closed_plain')
      and n.data ->> 'request_id' = any(select x::text from unnest(v_all) x)
      and (n.read_at is not null or exists (select 1 from public.push_outbox o where o.notification_id = n.id and o.status = 'sent')))
  into v_seen;

  -- Take the notice back: the inbox row (its undelivered push_outbox rows cascade) and a notice still held on the board.
  with gone as (
    delete from public.notifications n
    where n.event = 'outcome_changed' and n.data ->> 'variant' in ('request_closed', 'request_closed_plain')
      and n.data ->> 'request_id' = any(select x::text from unnest(v_all) x)
    returning 1)
  select count(*) into v_removed from gone;
  with gone as (
    delete from public.held_notices h
    where h.event = 'outcome_changed' and h.data ->> 'variant' in ('request_closed', 'request_closed_plain')
      and h.data ->> 'request_id' = any(select x::text from unnest(v_all) x)
    returning 1)
  select count(*) into v_held from gone;

  -- O29-2 (2): one short correction, only when there is something seen to correct
  if v_seen and v_req.requester_id is distinct from (select auth.uid()) then
    select full_name into v_by from public.profiles where id = (select auth.uid());
    perform public.enqueue_notification(v_req.requester_id, 'outcome_changed', v_req.department_id, v_req.week_start,
      jsonb_build_object('byName', coalesce(v_by, ''),
        'route', coalesce(public.request_route_label(p_request_id), ''),
        'day', public.day_date_label(coalesce(v_req.original_depart_at, v_req.depart_at, v_req.original_return_at, v_req.return_at))),
      jsonb_build_object('variant', 'request_restored', 'request_id', p_request_id, 'url', '/my'),
      format('request_restored:%s:%s', p_request_id, v_req.version));
  end if;

  return jsonb_build_object('request_id', p_request_id, 'status', 'waitlisted', 'restored', to_jsonb(v_all),
    'notices_removed', v_removed + v_held, 'member_told', coalesce(v_seen, false));
end $$;
