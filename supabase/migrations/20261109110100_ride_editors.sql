-- REQ §13.202 (owner 2026-11-08): "מי יכול/ה לערוך את הנסיעות שלי" - a member names any number of members of their
-- department who may edit and cancel the member's requests and rides as if they were related to them (REQ §13.127).
-- Per department (a member of two departments keeps two lists).

create table public.ride_editors (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  editor_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ride_editors_not_self check (owner_id <> editor_id),
  constraint ride_editors_unique unique (department_id, owner_id, editor_id)
);
create index ride_editors_editor_idx on public.ride_editors (editor_id, department_id);
create trigger ride_editors_set_updated_at before update on public.ride_editors
  for each row execute function public.set_updated_at();

comment on table public.ride_editors is
  'REQ §13.202: owner_id lets editor_id edit and cancel owner_id''s requests and rides in department_id. Written only by set_ride_editors().';

alter table public.ride_editors enable row level security;
alter table public.ride_editors force row level security;
-- The owner sees whom they named; the editor sees who named them. Writes go through set_ride_editors().
create policy ride_editors_select on public.ride_editors for select to authenticated
  using (owner_id = (select auth.uid()) or editor_id = (select auth.uid()));
grant select on public.ride_editors to authenticated;

-- Internal: p_actor is a current editor of p_owner in p_department (both still active, approved members).
create or replace function public._is_ride_editor(p_department uuid, p_owner uuid, p_actor uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_actor is not null and p_owner is not null and p_department is not null and p_actor <> p_owner and exists (
    select 1 from public.ride_editors e
    join public.department_members dm on dm.department_id = e.department_id and dm.profile_id = e.editor_id and dm.removed_at is null
    join public.profiles p on p.id = e.editor_id and p.approval_status = 'approved'
    where e.department_id = p_department and e.owner_id = p_owner and e.editor_id = p_actor);
$$;
revoke all on function public._is_ride_editor(uuid, uuid, uuid) from public, anon, authenticated;

-- RLS helper: the caller is an editor of p_owner in p_department.
create or replace function public.is_ride_editor_of(p_department uuid, p_owner uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public._is_ride_editor(p_department, p_owner, (select auth.uid()));
$$;
revoke all on function public.is_ride_editor_of(uuid, uuid) from public, anon;
grant execute on function public.is_ride_editor_of(uuid, uuid) to authenticated;

-- An editor counts as related to the owner's requests (REQ §13.127: edit, companions, children, notes, moves).
create or replace function public.request_related(p_request uuid, p_actor uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_actor is not null and exists (
    select 1 from public.requests q
    where q.id = p_request and (
      q.requester_id = p_actor or q.filed_by = p_actor
      or exists (select 1 from public.request_companions rc where rc.request_id = q.id and rc.profile_id = p_actor)
      or exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                 where rr.request_id = q.id and r.status <> 'cancelled' and public.ride_related(r.id, p_actor))
      -- REQ §13.202: someone the requester named as an editor of their rides.
      or public._is_ride_editor(q.department_id, q.requester_id, p_actor)
      -- REQ §13.169 (a): with the department's switch on, every approved member of the department.
      or (exists (select 1 from public.department_settings s where s.department_id = q.department_id and s.anyone_edits_rides)
          and exists (select 1 from public.department_members dm join public.profiles p on p.id = dm.profile_id
                      where dm.department_id = q.department_id and dm.profile_id = p_actor and dm.removed_at is null
                        and p.approval_status = 'approved'))));
$$;

-- ... and to the owner's rides: as the driver, or as a requester riding in it.
create or replace function public.ride_related(p_ride uuid, p_actor uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_actor is not null and exists (
    select 1 from public.rides r left join public.cars c on c.id = r.car_id
    where r.id = p_ride and (
      r.driver_id = p_actor
      or (c.type = 'temporary' and c.owner_id = p_actor)
      or exists (select 1 from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id = p_actor)
      or exists (select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
                 where rr.ride_id = r.id and (q.requester_id = p_actor or q.filed_by = p_actor
                   or exists (select 1 from public.request_companions rc where rc.request_id = q.id and rc.profile_id = p_actor)
                   or public._is_ride_editor(r.department_id, q.requester_id, p_actor)))
      -- REQ §13.202
      or public._is_ride_editor(r.department_id, r.driver_id, p_actor)));
$$;

-- REQ §13.202: an editor reads the owner's requests on every day (not only published ones), with what the form loads.
create policy requests_select_ride_editor on public.requests for select to authenticated
  using (public.is_ride_editor_of(department_id, requester_id));
create policy request_stops_select_ride_editor on public.request_stops for select to authenticated
  using (exists (select 1 from public.requests q where q.id = request_stops.request_id and public.is_ride_editor_of(q.department_id, q.requester_id)));
create policy request_companions_select_ride_editor on public.request_companions for select to authenticated
  using (exists (select 1 from public.requests q where q.id = request_companions.request_id and public.is_ride_editor_of(q.department_id, q.requester_id)));
create policy request_children_select_ride_editor on public.request_children for select to authenticated
  using (exists (select 1 from public.requests q where q.id = request_children.request_id and public.is_ride_editor_of(q.department_id, q.requester_id)));

insert into public.notification_event_meta (event, category, member_mutable, sadran_role, week_scoped)
values ('ride_editor_added', 'account', false, false, false);

-- An inbox row only, never a push (the owner asked for a quiet message): the template rendered as enqueue_notification does.
create or replace function public._notify_inbox_only(p_recipient uuid, p_event public.notification_event, p_department uuid,
  p_vars jsonb, p_data jsonb, p_dedupe text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_title text; v_body text; v_id uuid; v_data jsonb := coalesce(p_data, '{}'::jsonb);
begin
  if coalesce(current_setting('app.suppress_notifications', true), '') = 'on' then return null; end if;
  select title, body into v_title, v_body from public.notification_templates
  where event = p_event and channel = 'inbox' and variant is not distinct from nullif(v_data ->> 'variant', '');
  if v_body is null then
    select title, body into v_title, v_body from public.notification_templates where event = p_event and channel = 'inbox' and variant is null;
  end if;
  if nullif(v_data ->> 'url', '') is null then
    v_data := v_data || jsonb_build_object('url', public.notification_default_url(p_event, v_data, p_department, null, p_recipient));
  end if;
  insert into public.notifications (recipient_id, department_id, week_start, event, title_he, body_he, data, dedupe_key)
  values (p_recipient, p_department, null, p_event,
    public.render_notification_text(v_title, coalesce(p_vars, '{}'::jsonb)), public.render_notification_text(v_body, coalesce(p_vars, '{}'::jsonb)),
    v_data, p_dedupe)
  on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public._notify_inbox_only(uuid, public.notification_event, uuid, jsonb, jsonb, text) from public, anon, authenticated;

-- The caller's whole editor list for one department: adds tell the new editor once (inbox only), removals are silent.
create or replace function public.set_ride_editors(p_department_id uuid, p_editor_ids uuid[])
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_me uuid := (select auth.uid());
  v_ids uuid[] := array(select distinct x from unnest(coalesce(p_editor_ids, '{}'::uuid[])) x where x is not null);
  v_added record;
  v_name text;
begin
  if v_me is null or not public.is_approved() or not public.member_of(p_department_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if v_me = any(v_ids) or exists (
    select 1 from unnest(v_ids) x
    where not exists (select 1 from public.department_members dm join public.profiles p on p.id = dm.profile_id
                      where dm.department_id = p_department_id and dm.profile_id = x and dm.removed_at is null
                        and p.approval_status = 'approved')) then
    raise exception 'ride_editor_invalid' using errcode = 'P0001';
  end if;
  delete from public.ride_editors where department_id = p_department_id and owner_id = v_me and not (editor_id = any(v_ids));
  select full_name into v_name from public.profiles where id = v_me;
  for v_added in
    insert into public.ride_editors (department_id, owner_id, editor_id)
    select p_department_id, v_me, x from unnest(v_ids) x
    on conflict (department_id, owner_id, editor_id) do nothing
    returning id, editor_id
  loop
    perform public._notify_inbox_only(v_added.editor_id, 'ride_editor_added', p_department_id,
      jsonb_build_object('name', coalesce(v_name, '')), jsonb_build_object('owner_id', v_me), 'ride_editor_added:' || v_added.id);
  end loop;
end $$;
revoke all on function public.set_ride_editors(uuid, uuid[]) from public, anon;
grant execute on function public.set_ride_editors(uuid, uuid[]) to authenticated;
