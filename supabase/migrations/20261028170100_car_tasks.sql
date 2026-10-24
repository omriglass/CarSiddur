-- REQ item 150 (b): tasks for the next user of a car (fill tyres / wash / check kilometrage / other).
--
-- A manager of the car (can_manage_car) asks for one or more tasks. Whoever is on a published, non-cancelled ride of
-- that car sees an open task from 15 minutes before the ride starts until 15 minutes after it ends (the person is the
-- ride's driver; a driverless ride's people otherwise). Outside every window the task is simply not shown; it moves on
-- to the car's next ride. Members read tasks only through my_car_tasks() (the window rule is enforced there, not in the
-- UI); the table itself is readable by the car's managers only.

create type public.car_task_kind as enum ('tire_fill', 'wash', 'kilometrage', 'other');
create type public.car_task_status as enum ('open', 'done', 'withdrawn');

create table public.car_tasks (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id),
  car_id uuid not null references public.cars(id) on delete cascade,
  kind public.car_task_kind not null,
  note text,
  status public.car_task_status not null default 'open',
  requested_by uuid not null references public.profiles(id),
  requested_at timestamptz not null default clock_timestamp(),
  done_by uuid references public.profiles(id),
  done_at timestamptz,
  done_care_event_id uuid references public.car_care_events(id) on delete set null,
  done_odometer_reading_id uuid references public.car_odometer_readings(id) on delete set null,
  withdrawn_by uuid references public.profiles(id),
  withdrawn_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint car_tasks_note_ck check (note is null or length(note) <= 300),
  constraint car_tasks_other_note_ck check (kind <> 'other' or nullif(trim(coalesce(note, '')), '') is not null),
  constraint car_tasks_done_ck check ((status = 'done') = (done_by is not null and done_at is not null)),
  constraint car_tasks_withdrawn_ck check ((status = 'withdrawn') = (withdrawn_by is not null and withdrawn_at is not null))
);
create index car_tasks_car_idx on public.car_tasks (car_id, requested_at desc, id);
create index car_tasks_open_idx on public.car_tasks (car_id) where status = 'open';
create index car_tasks_department_idx on public.car_tasks (department_id);

create trigger set_updated_at before update on public.car_tasks
  for each row execute function public.set_updated_at();

alter table public.car_tasks enable row level security;
alter table public.car_tasks force row level security;

create policy car_tasks_select_manager on public.car_tasks for select to authenticated
  using (public.can_manage_car(car_id));

-- One notice per (ride, person): the push goes out once; later tasks only refresh the unread inbox entry.
create table public.car_task_notices (
  ride_id uuid not null references public.rides(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  notification_id uuid references public.notifications(id) on delete set null,
  notified_at timestamptz not null default now(),
  primary key (ride_id, profile_id)
);
alter table public.car_task_notices enable row level security;
alter table public.car_task_notices force row level security;
-- (no policies: internal, written and read by the definer functions below only)

-- Metadata, copy and kind labels ------------------------------------------------------------------------------------
insert into public.notification_event_meta (event, category, member_mutable, sadran_role, week_scoped)
values ('car_task', 'maintenance', true, false, false)
on conflict (event) do nothing;

insert into public.text_fragments (key, body) values
  ('car_task.tire_fill', 'למלא אוויר בצמיגים'),
  ('car_task.wash', 'לשטוף את הרכב'),
  ('car_task.kilometrage', 'לרשום את הקילומטראז׳')
on conflict (key) do nothing;

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'car_task'::public.notification_event, ch, null, t.title, t.body, t.title, t.body
from (values ('לפני הנסיעה ברכב {{car}} ב-{{depart}}', '{{tasks}}')) as t(title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do nothing;

-- Who is on a ride (for tasks): the driver when set, otherwise the people of the ride (requesters and companions of
-- the requests it serves, named member passengers). Profiles only.
create or replace function public._ride_task_people(p_ride_id uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  with r as (select id, driver_id from public.rides where id = p_ride_id)
  select r.driver_id from r where r.driver_id is not null
  union
  select x.pid from r cross join lateral (
    select q.requester_id as pid
      from public.ride_requests rr join public.requests q on q.id = rr.request_id where rr.ride_id = r.id
    union
    select rc.profile_id
      from public.ride_requests rr join public.request_companions rc on rc.request_id = rr.request_id where rr.ride_id = r.id
    union
    select rp.person_id from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id is not null
  ) x
  where r.driver_id is null and x.pid is not null;
$$;
revoke all on function public._ride_task_people(uuid) from public;
grant execute on function public._ride_task_people(uuid) to service_role;

-- The open tasks a person sees at p_now, one row per (task, qualifying ride). A ride qualifies when it is published
-- (confirmed / flagged: an unpublished 'draft' day is invisible to members) and p_now is inside
-- [starts_at - 15 min, ends_at + 15 min], and its window had not already passed when the task was requested.
create or replace function public._car_tasks_for_profile(p_profile_id uuid, p_now timestamptz)
returns table (task_id uuid, department_id uuid, car_id uuid, car_name text, kind public.car_task_kind, note text,
               requested_at timestamptz, requested_by uuid, requested_by_name text,
               ride_id uuid, ride_starts_at timestamptz, ride_ends_at timestamptz,
               window_starts_at timestamptz, window_ends_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select t.id, t.department_id, t.car_id, c.name, t.kind, t.note, t.requested_at, t.requested_by, p.full_name,
         r.id, r.starts_at, r.ends_at, r.starts_at - interval '15 minutes', r.ends_at + interval '15 minutes'
  from public.car_tasks t
  join public.cars c on c.id = t.car_id
  join public.profiles p on p.id = t.requested_by
  join public.rides r on r.car_id = t.car_id and r.status in ('confirmed', 'flagged')
    and p_now >= r.starts_at - interval '15 minutes'
    and p_now <= r.ends_at + interval '15 minutes'
    and r.ends_at + interval '15 minutes' > t.requested_at
  where t.status = 'open'
    and p_profile_id in (select public._ride_task_people(r.id))
  order by r.starts_at, t.requested_at, t.id;
$$;
revoke all on function public._car_tasks_for_profile(uuid, timestamptz) from public;
grant execute on function public._car_tasks_for_profile(uuid, timestamptz) to service_role;

create or replace function public.my_car_tasks()
returns table (task_id uuid, department_id uuid, car_id uuid, car_name text, kind public.car_task_kind, note text,
               requested_at timestamptz, requested_by uuid, requested_by_name text,
               ride_id uuid, ride_starts_at timestamptz, ride_ends_at timestamptz,
               window_starts_at timestamptz, window_ends_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select * from public._car_tasks_for_profile((select auth.uid()), now())
  where public.is_approved();
$$;
revoke all on function public.my_car_tasks() from public;
grant execute on function public.my_car_tasks() to authenticated, service_role;

-- Label of one task for a notice ("other" shows its note).
create or replace function public._car_task_label(p_kind public.car_task_kind, p_note text) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case when p_kind = 'other' then coalesce(p_note, '')
              else coalesce((select body from public.text_fragments where key = 'car_task.' || p_kind::text), '') end;
$$;
revoke all on function public._car_task_label(public.car_task_kind, text) from public;
grant execute on function public._car_task_label(public.car_task_kind, text) to service_role;

-- The text of a person's notice: every open task of the car that this ride carries.
create or replace function public._car_task_notice_tasks(p_ride_id uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(string_agg(public._car_task_label(t.kind, t.note), ', ' order by t.requested_at, t.id), '')
  from public.rides r
  join public.car_tasks t on t.car_id = r.car_id and t.status = 'open'
    and r.ends_at + interval '15 minutes' > t.requested_at
  where r.id = p_ride_id;
$$;
revoke all on function public._car_task_notice_tasks(uuid) from public;
grant execute on function public._car_task_notice_tasks(uuid) to service_role;

-- Tick step: for rides starting within the next 30 minutes, one notice per (ride, person) listing the open tasks.
-- The 15-minute tick therefore sends it 15-30 minutes before the start; a ride already running gets the card only.
create or replace function public.send_car_task_notices(p_now timestamptz default now()) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  rec record;
  v_tasks text;
  v_notice uuid;
begin
  for rec in
    select distinct r.id as ride_id, r.department_id, p.pid as profile_id
    from public.rides r
    join public.car_tasks t on t.car_id = r.car_id and t.status = 'open'
      and r.ends_at + interval '15 minutes' > t.requested_at
    cross join lateral (select public._ride_task_people(r.id) as pid) p
    join public.profiles pr on pr.id = p.pid and pr.approval_status = 'approved'
    where r.status in ('confirmed', 'flagged')
      and r.starts_at > p_now and r.starts_at <= p_now + interval '30 minutes'
      and not exists (select 1 from public.car_task_notices n where n.ride_id = r.id and n.profile_id = p.pid)
    order by r.id, p.pid
  loop
    v_tasks := public._car_task_notice_tasks(rec.ride_id);
    continue when v_tasks = '';
    insert into public.car_task_notices (ride_id, profile_id) values (rec.ride_id, rec.profile_id)
    on conflict do nothing;
    continue when not found;
    v_notice := public.enqueue_notification(rec.profile_id, 'car_task', rec.department_id, null,
      jsonb_build_object('tasks', v_tasks),
      jsonb_build_object('ride_id', rec.ride_id, 'url', '/my'),
      format('car_task:%s:%s', rec.ride_id, rec.profile_id));
    update public.car_task_notices set notification_id = v_notice
      where ride_id = rec.ride_id and profile_id = rec.profile_id;
  end loop;
end $$;
revoke all on function public.send_car_task_notices(timestamptz) from public, anon, authenticated;
grant execute on function public.send_car_task_notices(timestamptz) to service_role;

-- A task added / withdrawn after a person was notified: the unread inbox entry is re-rendered (never a second push).
create or replace function public._refresh_car_task_notices(p_car_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  rec record;
  v_tasks text;
  v_title text; v_body text;
  v_vars jsonb;
begin
  select title, body into v_title, v_body from public.notification_templates
    where event = 'car_task' and channel = 'inbox' and variant is null;
  for rec in
    select n.ride_id, n.profile_id, n.notification_id, r.department_id
    from public.car_task_notices n
    join public.rides r on r.id = n.ride_id
    join public.notifications nt on nt.id = n.notification_id and nt.read_at is null
    where r.car_id = p_car_id and r.ends_at + interval '15 minutes' > now()
  loop
    v_tasks := public._car_task_notice_tasks(rec.ride_id);
    continue when v_tasks = '';
    v_vars := public.notification_context(rec.profile_id, rec.department_id, null,
        jsonb_build_object('ride_id', rec.ride_id)) || jsonb_build_object('tasks', v_tasks);
    update public.notifications
      set title_he = public.render_notification_text(v_title, v_vars),
          body_he = public.render_notification_text(v_body, v_vars)
      where id = rec.notification_id;
  end loop;
end $$;
revoke all on function public._refresh_car_task_notices(uuid) from public;
grant execute on function public._refresh_car_task_notices(uuid) to service_role;

-- Managers ask for tasks. Open tasks of the same non-"other" kind are not duplicated. Returns the number created.
create or replace function public.request_car_tasks(p_car_id uuid, p_kinds public.car_task_kind[], p_note text default null)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dept uuid;
  v_kind public.car_task_kind;
  v_note text := nullif(left(trim(coalesce(p_note, '')), 300), '');
  v_count integer := 0;
begin
  select department_id into v_dept from public.cars where id = p_car_id;
  if v_dept is null then raise exception 'car_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_car(p_car_id) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_kinds is null or cardinality(p_kinds) = 0 then raise exception 'invalid_input' using errcode = 'P0001'; end if;
  foreach v_kind in array (select array_agg(distinct k) from unnest(p_kinds) k) loop
    if v_kind = 'other' then
      if v_note is null then raise exception 'task_note_required' using errcode = 'P0001'; end if;
      insert into public.car_tasks (department_id, car_id, kind, note, requested_by)
      values (v_dept, p_car_id, 'other', v_note, (select auth.uid()));
      v_count := v_count + 1;
    elsif not exists (select 1 from public.car_tasks t where t.car_id = p_car_id and t.kind = v_kind and t.status = 'open') then
      insert into public.car_tasks (department_id, car_id, kind, requested_by)
      values (v_dept, p_car_id, v_kind, (select auth.uid()));
      v_count := v_count + 1;
    end if;
  end loop;
  if v_count > 0 then perform public._refresh_car_task_notices(p_car_id); end if;
  return v_count;
end $$;
revoke all on function public.request_car_tasks(uuid, public.car_task_kind[], text) from public;
grant execute on function public.request_car_tasks(uuid, public.car_task_kind[], text) to authenticated, service_role;

create or replace function public.withdraw_car_task(p_task_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t public.car_tasks%rowtype;
begin
  select * into t from public.car_tasks where id = p_task_id for update;
  if not found then raise exception 'task_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_car(t.car_id) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if t.status <> 'open' then raise exception 'task_not_open' using errcode = 'P0001'; end if;
  update public.car_tasks set status = 'withdrawn', withdrawn_by = (select auth.uid()), withdrawn_at = clock_timestamp()
    where id = p_task_id;
  perform public._refresh_car_task_notices(t.car_id);
end $$;
revoke all on function public.withdraw_car_task(uuid) from public;
grant execute on function public.withdraw_car_task(uuid) to authenticated, service_role;

-- "ביצעתי" on an 'other' task: only a person who currently sees it (their ride's window contains now).
create or replace function public.complete_car_task(p_task_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t public.car_tasks%rowtype;
begin
  select * into t from public.car_tasks where id = p_task_id for update;
  if not found then raise exception 'task_not_found' using errcode = 'P0001'; end if;
  if t.kind <> 'other' then raise exception 'task_not_manual' using errcode = 'P0001'; end if;
  if not exists (select 1 from public._car_tasks_for_profile((select auth.uid()), now()) x where x.task_id = p_task_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if t.status <> 'open' then raise exception 'task_not_open' using errcode = 'P0001'; end if;
  update public.car_tasks set status = 'done', done_by = (select auth.uid()), done_at = clock_timestamp()
    where id = p_task_id;
end $$;
revoke all on function public.complete_car_task(uuid) from public;
grant execute on function public.complete_car_task(uuid) to authenticated, service_role;

-- Internal: a logged tyre fill / wash / kilometrage completes the car's open task of that kind.
create or replace function public._complete_car_tasks(p_car_id uuid, p_kind public.car_task_kind, p_by uuid,
  p_care_event_id uuid default null, p_odometer_id uuid default null) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  update public.car_tasks
    set status = 'done', done_by = p_by, done_at = clock_timestamp(),
        done_care_event_id = p_care_event_id, done_odometer_reading_id = p_odometer_id
    where car_id = p_car_id and kind = p_kind and status = 'open';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public._complete_car_tasks(uuid, public.car_task_kind, uuid, uuid, uuid) from public;
grant execute on function public._complete_car_tasks(uuid, public.car_task_kind, uuid, uuid, uuid) to service_role;
