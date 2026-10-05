-- REQ §13.101 (e): the Sadran may withdraw a request as a duplicate; the member may answer
-- "not a duplicate — I need both", which restores it to placement and tells the Sadran.
create or replace function public.withdraw_duplicate_request(p_request_id uuid, p_expected_version int)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_req public.requests%rowtype; v_actor uuid := (select auth.uid()); v_by text; v_prop uuid;
begin
  select * into v_req from public.requests where id = p_request_id for update;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_req.department_id, v_req.week_start) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_expected_version is null or v_req.version <> p_expected_version then perform public.raise_stale_version(); end if;
  if v_req.status in ('withdrawn', 'cancelled') then raise exception 'request_not_editable' using errcode = 'P0001'; end if;
  if v_req.series_id is not null then raise exception 'series_edit_not_supported' using errcode = 'MDR02'; end if;
  if exists (select 1 from public.weeks where department_id = v_req.department_id and week_start = v_req.week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  perform set_config('app.audit_reason', 'withdraw_duplicate_request', true);

  for v_prop in
    select p.id from public.proposals p
    where p.status in ('draft', 'sent')
      and (p.request_id = p_request_id or exists (select 1 from public.proposal_parties pp where pp.proposal_id = p.id and pp.request_id = p_request_id))
    for update
  loop
    update public.proposals set status = 'withdrawn' where id = v_prop;
  end loop;

  perform public.release_request_booking(p_request_id);
  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'withdrawn', status_reason = 'DUPLICATE_WITHDRAWN' where id = p_request_id;
  perform set_config('app.system_status_transition', 'off', true);

  select full_name into v_by from public.profiles where id = v_actor;
  if v_req.requester_id is distinct from v_actor then
    perform public.enqueue_notification(v_req.requester_id, 'outcome_changed', v_req.department_id, v_req.week_start,
      jsonb_build_object('byName', coalesce(v_by, ''), 'route', coalesce(public.request_route_label(p_request_id), ''),
        'day', public.day_date_label(coalesce(v_req.depart_at, v_req.return_at))),
      jsonb_build_object('variant', 'duplicate_withdrawn', 'request_id', p_request_id, 'url', '/my'),
      format('duplicate_withdrawn:%s:%s', p_request_id, v_req.version));
  end if;
  return jsonb_build_object('request_id', p_request_id, 'status', 'withdrawn', 'status_reason', 'DUPLICATE_WITHDRAWN');
end $$;

create or replace function public.restore_duplicate_request(p_request_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_req public.requests%rowtype; v_actor uuid := (select auth.uid()); v_phase public.week_phase;
  v_auto jsonb; v_status public.request_status; v_by text;
begin
  select * into v_req from public.requests where id = p_request_id for update;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if v_req.requester_id is distinct from v_actor then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if v_req.status <> 'withdrawn' or v_req.status_reason is distinct from 'DUPLICATE_WITHDRAWN' then
    raise exception 'request_not_editable' using errcode = 'P0001';
  end if;
  if coalesce(v_req.return_at, v_req.depart_at) < now() then raise exception 'ride_in_past' using errcode = 'P0001'; end if;
  select phase into v_phase from public.weeks where department_id = v_req.department_id and week_start = v_req.week_start;
  if v_phase is null or v_phase in ('archived', 'upcoming') then raise exception 'week_archived' using errcode = 'P0001'; end if;

  perform set_config('app.audit_reason', 'restore_duplicate_request', true);
  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status = 'submitted', status_reason = 'DUPLICATE_RESTORED', changed_since_solve = (v_phase not in ('open', 'solving'))
  where id = p_request_id;
  perform set_config('app.system_status_transition', 'off', true);

  if v_phase in ('published', 'live') and v_req.trip_type in ('round_trip', 'one_way') then
    v_auto := public.try_auto_approve(p_request_id);
  end if;
  select status into v_status from public.requests where id = p_request_id;
  if v_phase in ('published', 'live') and v_status = 'submitted' then
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'waitlisted', status_reason = 'WAITLISTED_ONE_WAY' where id = p_request_id;
    perform set_config('app.system_status_transition', 'off', true);
    v_status := 'waitlisted';
    v_auto := coalesce(v_auto, jsonb_build_object('status', 'waitlisted', 'reason', 'WAITLISTED_ONE_WAY'));
  end if;

  select full_name into v_by from public.profiles where id = v_actor;
  perform public.enqueue_notification(s.profile_id, 'outcome_changed', v_req.department_id, v_req.week_start,
    jsonb_build_object('byName', coalesce(v_by, ''), 'route', coalesce(public.request_route_label(p_request_id), ''),
      'day', public.day_date_label(coalesce(v_req.depart_at, v_req.return_at))),
    jsonb_build_object('variant', 'duplicate_restored', 'request_id', p_request_id,
      'url', format('/sadran/%s/%s/board', v_req.department_id, v_req.week_start)),
    format('duplicate_restored:%s:%s:%s', p_request_id, v_req.version, s.profile_id))
  from public.sadranim_of(v_req.department_id, v_req.week_start) as s(profile_id);

  return jsonb_build_object('request_id', p_request_id, 'status', v_status::text,
    'car_was_free', v_status = 'assigned') || coalesce(v_auto, '{}'::jsonb);
end $$;

revoke all on function public.withdraw_duplicate_request(uuid, int) from public, anon;
revoke all on function public.restore_duplicate_request(uuid) from public, anon;
grant execute on function public.withdraw_duplicate_request(uuid, int) to authenticated;
grant execute on function public.restore_duplicate_request(uuid) to authenticated;

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'outcome_changed', ch, t.variant, t.title, t.body, t.title, t.body
from (values
  ('duplicate_withdrawn', 'הבקשה {{route}} בוטלה ככפולה', '{{day}} · {{byName}} ראה/תה שהגשת אותה פעמיים. אם צריך את שתיהן, אפשר לשחזר ב"הנסיעות שלי"'),
  ('duplicate_restored', '{{byName}}: לא כפולה, צריך/ה את שתיהן', '{{route}} · {{day}} · הבקשה חזרה לשיבוץ')
) as t(variant, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do update
  set title = excluded.title, body = excluded.body, default_title = excluded.default_title, default_body = excluded.default_body;
