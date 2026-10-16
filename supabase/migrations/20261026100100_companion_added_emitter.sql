-- REQ §13.135 (owner 2026-10-16) — `companion_added`: when member A files a request that names
-- member B as a companion (`request_companions`, written by submit_request / set_request_companions),
-- B is notified once. B can already read the request (`requests_select` uses `is_request_companion`),
-- so /my lists it with no RLS change.

insert into public.notification_event_meta (event, category, member_mutable, sadran_role, week_scoped)
values ('companion_added', 'siddur', true, false, true)
on conflict (event) do nothing;

-- Copy: default (round trip / one way with a return) and `no_return` (no return time).
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'companion_added'::public.notification_event, ch, t.variant, t.title, t.body, t.title, t.body
from (values
  (null::text, 'נרשמת כנוסע/ת בבקשה של {{name}}',
   '{{name}} הגיש/ה בקשה שבה את/ה נוסע/ת: ביום {{day}} {{depart}}–{{return}} {{route}}. אם זה לא נכון, כדאי ליצור קשר עם {{name}}.'),
  ('no_return', 'נרשמת כנוסע/ת בבקשה של {{name}}',
   '{{name}} הגיש/ה בקשה שבה את/ה נוסע/ת: ביום {{day}} {{depart}} {{route}}. אם זה לא נכון, כדאי ליצור קשר עם {{name}}.')
) t(variant, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) ch
on conflict (event, channel, coalesce(variant, '')) do nothing;

-- Internal emitter (no grant): only for a newly added companion who is neither the requester nor the
-- filer, on a live request; one notice per (series or request, person) via the dedupe key, so an edit
-- that deletes and re-inserts the same companion never re-notifies.
create or replace function public.on_request_companion_added()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  q public.requests%rowtype;
  v_actor uuid;
  v_name text;
  v_at timestamptz;
begin
  select * into q from public.requests where id = new.request_id;
  if not found
     or q.status in ('withdrawn', 'cancelled')
     or q.plan_b_parent_id is not null
     or new.profile_id = q.requester_id
     or new.profile_id = coalesce(q.filed_by, q.requester_id) then
    return new;
  end if;
  v_actor := coalesce(q.filed_by, q.requester_id);
  select full_name into v_name from public.profiles where id = v_actor;
  v_at := coalesce(q.depart_at, q.return_at);
  perform public.enqueue_notification(
    new.profile_id, 'companion_added', q.department_id, q.week_start,
    jsonb_build_object(
      'name', coalesce(v_name, ''),
      'day', public.day_date_label(v_at),
      'depart', to_char(v_at at time zone 'Asia/Jerusalem', 'HH24:MI'),
      'return', coalesce(to_char(case when q.depart_at is not null then q.return_at end at time zone 'Asia/Jerusalem', 'HH24:MI'), '')),
    jsonb_build_object('request_id', q.id)
      || case when q.depart_at is not null and q.return_at is not null then '{}'::jsonb else jsonb_build_object('variant', 'no_return') end,
    'companion_added:' || coalesce(q.series_id, q.id)::text || ':' || new.profile_id::text);
  return new;
end;
$$;

revoke all on function public.on_request_companion_added() from public;

drop trigger if exists request_companion_added_notify on public.request_companions;
create trigger request_companion_added_notify after insert on public.request_companions
  for each row execute function public.on_request_companion_added();
