-- REQ item 150 (d): copy for the handover checklist notices (reusing the car_care event, two variants) and the
-- date-item reminders.
--   checklist_requested: the new responsible person is asked to complete the checklist.
--   checklist_dates: one combined notice per person per tick listing the date items that are due ({{list}}, one
--                    "label · car · date" line each; the copy around it lives here).
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'car_care'::public.notification_event, ch, t.variant, t.title, t.body, t.title, t.body
from (values
  ('checklist_requested', 'את/ה אחראי/ת על {{carName}} — צריך למלא בדיקת רכב', 'נא למלא את רשימת הבדיקה של {{carName}} בדף הרכב (״בדיקת רכב״).'),
  ('checklist_dates', 'מועדים מתקרבים ברכבים', '{{list}}')
) as t(variant, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do nothing;

-- Date items remind the responsible person and the department's car admins once per (car, item, date), from
-- remind_days_before days ahead until the date itself. The date comes from the car's latest checklist.
create or replace function public.send_car_checklist_date_reminders(p_now timestamptz default now()) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_today date := (p_now at time zone 'Asia/Jerusalem')::date;
  v_rec record;
begin
  for v_rec in
    with latest as (
      select distinct on (c.car_id) c.id, c.car_id from public.car_checklists c order by c.car_id, c.completed_at desc, c.id desc),
    due as (
      select l.car_id, a.item_id, a.department_id, a.answer_date, a.label, c.name as car_name, c.responsible_id
      from latest l
      join public.car_checklist_answers a on a.checklist_id = l.id and a.kind = 'date' and a.answer_date is not null
      join public.car_checklist_items i on i.id = a.item_id and i.active and i.remind_days_before is not null
      join public.cars c on c.id = l.car_id and c.type = 'shared' and c.status <> 'retired'
      where v_today between a.answer_date - i.remind_days_before and a.answer_date),
    fresh as (
      insert into public.car_checklist_date_reminders (car_id, item_id, date_value, department_id)
      select d.car_id, d.item_id, d.answer_date, d.department_id from due d
      on conflict do nothing
      returning car_id, item_id, date_value),
    lines as (
      select d.department_id,
             d.label || ' · ' || d.car_name || ' · ' || public.day_date_label(d.answer_date) as line, r.recipient
      from fresh f
      join due d on d.car_id = f.car_id and d.item_id = f.item_id and d.answer_date = f.date_value
      cross join lateral (
        select d.responsible_id as recipient where d.responsible_id is not null
        union
        select dm.profile_id from public.department_members dm
          join public.profiles p on p.id = dm.profile_id and p.approval_status = 'approved'
          where dm.department_id = d.department_id and dm.removed_at is null and dm.is_car_admin) r)
    select recipient, (array_agg(department_id))[1] as department_id, string_agg(line, E'\n' order by line) as list
    from lines group by recipient
  loop
  perform public.enqueue_notification(v_rec.recipient, 'car_care', v_rec.department_id, null,
      jsonb_build_object('list', v_rec.list),
      jsonb_build_object('variant', 'checklist_dates'),
      format('car_care:checklist_dates:%s:%s', v_rec.recipient, (extract(epoch from p_now) * 1000)::bigint));
  end loop;
end;
$$;
revoke all on function public.send_car_checklist_date_reminders(timestamptz) from public;
grant execute on function public.send_car_checklist_date_reminders(timestamptz) to service_role;

-- One more step in the single cron entry (full definition; every other step unchanged, incl. send_car_task_notices
-- from REQ item 150 b).
create or replace function app.tick(p_now timestamptz default now())
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_step text;
begin
  foreach v_step in array array['advance_week_phases', 'send_due_reminders', 'expire_proposals', 'remind_unsent_board_changes',
    'send_car_task_notices', 'send_car_checklist_date_reminders', 'drain_push_outbox', 'housekeeping'] loop
    begin
      execute format('select public.%I($1)', v_step) using p_now;
    exception when others then
      raise warning 'app.tick: step % failed: % (%)', v_step, sqlerrm, sqlstate;
      insert into public.app_settings (key, value, updated_at)
      values ('tick_last_error', jsonb_build_object('step', v_step, 'message', sqlerrm, 'sqlstate', sqlstate, 'at', p_now), p_now)
      on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
    end;
  end loop;
end;
$function$;
