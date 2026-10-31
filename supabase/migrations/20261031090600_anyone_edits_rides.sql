-- REQ §13.169 (owner 2026-10-31): a department switch that lets every approved member edit any request of the
-- department (the siddur ride sheet opens it in the sentence form), and one merged notice to its riders listing what
-- changed.
--   (a) `department_settings.anyone_edits_rides` (off by default) makes `request_related()` true for every approved
--       member of the request's department — every "related" gate (submit_request, companions, children, shorten,
--       member ride moves, notes) follows. Such an editor also reads the request's plan B, so a save keeps it.
--   (c)/(d) A save made from the request form (the browser marks those calls `x-request-form: 1`) remembers each
--       request's state before the first change of the transaction (`_ride_edit_capture`) and, at commit, tells each
--       rider before or after the edit (requester, named members, the published ride's driver; never the editor) one
--       `ride_edited` notice listing the changes. A rider's still-unread notice of the same request is folded in: its
--       stored `before` stays the base, so the one entry lists everything since the rider last looked, and the push
--       carries a `replace:` tag so the phone shows one notice, not a burst.
--   (e) `profiles.push_on_ride_edits` (on by default): off = the inbox entry only.
--   (f) A Sadran editing on the board keeps the board's own (held) notices: no `ride_edited` there.

alter table public.department_settings add column anyone_edits_rides boolean not null default false;

-- Self-service like `classic_request_form` (the `profiles_update` policy; explicit column grants for select).
alter table public.profiles add column push_on_ride_edits boolean not null default true;
grant select (push_on_ride_edits) on public.profiles to authenticated;

insert into public.notification_event_meta (event, category, member_mutable, sadran_role, week_scoped)
values ('ride_edited', 'siddur', false, false, true)
on conflict (event) do nothing;

insert into public.text_fragments (key, body) values
  ('ride_edit.trip_type', '{{new}} במקום {{old}}'),
  ('ride_edit.route', 'מסלול: {{new}} במקום {{old}}'),
  ('ride_edit.driver', 'נהג/ת: {{new}} במקום {{old}}'),
  ('ride_edit.driver_none', 'הנסיעה צריכה נהג/ת'),
  ('ride_edit.car_set', 'רכב {{car}}'),
  ('ride_edit.car_none', 'בלי רכב כרגע'),
  ('ride_edit.joined', 'נוספו: {{names}}'),
  ('ride_edit.left', 'ירדו מהנסיעה: {{names}}'),
  ('ride_edit.unnamed', 'נוסעים בלי שם: {{new}} במקום {{old}}'),
  ('ride_edit.luggage_on', 'עם ציוד רב'),
  ('ride_edit.luggage_off', 'בלי ציוד רב'),
  ('ride_edit.ride_type', 'סוג נסיעה: {{new}} במקום {{old}}'),
  ('ride_edit.note', 'הערה: {{note}}'),
  ('ride_edit.note_cleared', 'ההערה נמחקה'),
  ('ride_edit.description', 'תיאור: {{text}}')
on conflict (key) do update set body = excluded.body, updated_at = now();

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'ride_edited'::public.notification_event, ch, null, t.title, t.body, t.title, t.body
from (values ('{{byName}} שינה/תה את הנסיעה שלך', '{{route}} · {{day}} · {{changes}}')) as t(title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do nothing;

-- (a) Full definition of request_related (schema-current.sql) with the department switch added.
CREATE OR REPLACE FUNCTION "public"."request_related"("p_request" "uuid", "p_actor" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select p_actor is not null and exists (
    select 1 from public.requests q
    where q.id = p_request and (
      q.requester_id = p_actor or q.filed_by = p_actor
      or exists (select 1 from public.request_companions rc where rc.request_id = q.id and rc.profile_id = p_actor)
      or exists (select 1 from public.ride_requests rr join public.rides r on r.id = rr.ride_id
                 where rr.request_id = q.id and r.status <> 'cancelled' and public.ride_related(r.id, p_actor))
      -- REQ §13.169 (a): with the department's switch on, every approved member of the department.
      or (exists (select 1 from public.department_settings s where s.department_id = q.department_id and s.anyone_edits_rides)
          and exists (select 1 from public.department_members dm join public.profiles p on p.id = dm.profile_id
                      where dm.department_id = q.department_id and dm.profile_id = p_actor and dm.removed_at is null
                        and p.approval_status = 'approved'))));
$$;

-- (a) Whoever may edit a request reads its plan B (the form loads and re-saves it).
create policy request_alternatives_select_editor on public.request_alternatives for select to authenticated
  using (public.can_edit_request(request_id));

-- "a, b ו-c"
create or replace function public._and_list(p_items text[]) returns text
  language sql stable set search_path = public, pg_temp as $$
  select case
    when coalesce(cardinality(p_items), 0) = 0 then ''
    when cardinality(p_items) = 1 then p_items[1]
    else array_to_string(p_items[1:cardinality(p_items) - 1], ', ') || public._frag('list.and') || p_items[cardinality(p_items)]
  end;
$$;

-- (c) What a rider sees of a request: the form's content, who rides and drives, and — on a published day only
-- (R8B7: no outcome before publishing) — the ride's car and driver. `recipients` are its riders.
create or replace function public._ride_edit_snapshot(p_request uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  q public.requests%rowtype;
  v_public boolean;
  v_ride record;
begin
  select * into q from public.requests where id = p_request;
  if q.id is null then return null; end if;
  v_public := public.is_day_public(q.department_id, q.week_start,
    (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date);
  select r.driver_id, d.full_name as driver_name, c.name as car_name into v_ride
  from public.ride_requests rr join public.rides r on r.id = rr.ride_id
  left join public.profiles d on d.id = r.driver_id left join public.cars c on c.id = r.car_id
  where v_public and rr.request_id = q.id and r.status <> 'cancelled'
  order by r.starts_at, r.id limit 1;
  return jsonb_build_object(
    'depart_at', q.depart_at, 'return_at', q.return_at, 'trip_type', q.trip_type,
    'route', coalesce(public.request_route_label(q.id), ''),
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.full_name) order by m.ord, m.full_name, m.id) from (
        select p.id, p.full_name, 0 as ord from public.profiles p where p.id = q.requester_id
        union all
        select p.id, p.full_name, 1 from public.request_companions rc join public.profiles p on p.id = rc.profile_id
        where rc.request_id = q.id and rc.profile_id <> q.requester_id) m), '[]'::jsonb),
    'children', coalesce((select jsonb_agg(ch.full_name order by ch.full_name, ch.id)
        from public.request_children rc join public.children ch on ch.id = rc.child_id where rc.request_id = q.id), '[]'::jsonb),
    'guests', to_jsonb(coalesce(q.guest_passenger_names, '{}'::text[])),
    'seats', coalesce(q.adults, 0) + coalesce(q.child_seats, 0) + coalesce(q.boosters, 0),
    'luggage', coalesce(q.has_luggage, false),
    'notes', coalesce(q.notes, ''),
    'description', coalesce(q.ride_description, ''),
    'ride_type', coalesce((select t.name_he from public.ride_types t where t.id = q.ride_type_id), ''),
    'driver', coalesce(v_ride.driver_name, case when q.trip_type <> 'drop_off'
        then (select p.full_name from public.profiles p where p.id = public.eligible_leg_driver(q.id)) end),
    'car', v_ride.car_name,
    'recipients', coalesce((select jsonb_agg(distinct x) from (
        select q.requester_id as x
        union select rc.profile_id from public.request_companions rc where rc.request_id = q.id
        union select r.driver_id from public.ride_requests rr join public.rides r on r.id = rr.ride_id
          where v_public and rr.request_id = q.id and r.status <> 'cancelled' and r.driver_id is not null) s
        where x is not null), '[]'::jsonb));
end $$;

-- (c) The change lines between two snapshots, old -> new, in reading order.
create or replace function public._ride_edit_lines(b jsonb, a jsonb) returns text[]
  language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_lines text[] := '{}';
  v_time text;
  v_joined text[]; v_left text[];
  v_named_b int; v_named_a int;
begin
  v_time := public._time_change_line((b ->> 'depart_at')::timestamptz, (b ->> 'return_at')::timestamptz,
    (a ->> 'depart_at')::timestamptz, (a ->> 'return_at')::timestamptz);
  if nullif(v_time, '') is not null then v_lines := v_lines || v_time; end if;
  if (b ->> 'trip_type') is distinct from (a ->> 'trip_type') then
    v_lines := v_lines || public._frag('ride_edit.trip_type', jsonb_build_object(
      'new', public._frag('trip_type.' || (a ->> 'trip_type')), 'old', public._frag('trip_type.' || (b ->> 'trip_type'))));
  end if;
  if (b ->> 'route') is distinct from (a ->> 'route') then
    v_lines := v_lines || public._frag('ride_edit.route', jsonb_build_object('new', a ->> 'route', 'old', b ->> 'route'));
  end if;
  if (b ->> 'driver') is distinct from (a ->> 'driver') then
    v_lines := v_lines || case
      when a ->> 'driver' is null then public._frag('ride_edit.driver_none')
      when b ->> 'driver' is null then public._frag('change.driver', jsonb_build_object('driverName', a ->> 'driver'))
      else public._frag('ride_edit.driver', jsonb_build_object('new', a ->> 'driver', 'old', b ->> 'driver')) end;
  end if;
  if (b ->> 'car') is distinct from (a ->> 'car') then
    v_lines := v_lines || case
      when a ->> 'car' is null then public._frag('ride_edit.car_none')
      when b ->> 'car' is null then public._frag('ride_edit.car_set', jsonb_build_object('car', a ->> 'car'))
      else public._frag('change.car', jsonb_build_object('newCar', a ->> 'car', 'oldCar', b ->> 'car')) end;
  end if;
  -- who rides: members by id, children and guests by name
  select array_agg(m ->> 'name' order by o) into v_joined from jsonb_array_elements(a -> 'members') with ordinality x(m, o)
    where not exists (select 1 from jsonb_array_elements(b -> 'members') y where y ->> 'id' = m ->> 'id');
  select array_agg(m ->> 'name' order by o) into v_left from jsonb_array_elements(b -> 'members') with ordinality x(m, o)
    where not exists (select 1 from jsonb_array_elements(a -> 'members') y where y ->> 'id' = m ->> 'id');
  v_joined := coalesce(v_joined, '{}') || coalesce(array(select n from jsonb_array_elements_text(a -> 'children') n
      where not (b -> 'children') ? n), '{}') || coalesce(array(select n from jsonb_array_elements_text(a -> 'guests') n
      where not (b -> 'guests') ? n), '{}');
  v_left := coalesce(v_left, '{}') || coalesce(array(select n from jsonb_array_elements_text(b -> 'children') n
      where not (a -> 'children') ? n), '{}') || coalesce(array(select n from jsonb_array_elements_text(b -> 'guests') n
      where not (a -> 'guests') ? n), '{}');
  if cardinality(v_joined) > 0 then v_lines := v_lines || public._frag('ride_edit.joined', jsonb_build_object('names', public._and_list(v_joined))); end if;
  if cardinality(v_left) > 0 then v_lines := v_lines || public._frag('ride_edit.left', jsonb_build_object('names', public._and_list(v_left))); end if;
  -- passengers without a name: the seats nobody named
  v_named_b := jsonb_array_length(b -> 'members') + jsonb_array_length(b -> 'children') + jsonb_array_length(b -> 'guests');
  v_named_a := jsonb_array_length(a -> 'members') + jsonb_array_length(a -> 'children') + jsonb_array_length(a -> 'guests');
  if greatest((b ->> 'seats')::int - v_named_b, 0) <> greatest((a ->> 'seats')::int - v_named_a, 0) then
    v_lines := v_lines || public._frag('ride_edit.unnamed', jsonb_build_object(
      'new', greatest((a ->> 'seats')::int - v_named_a, 0), 'old', greatest((b ->> 'seats')::int - v_named_b, 0)));
  end if;
  if (b ->> 'luggage') is distinct from (a ->> 'luggage') then
    v_lines := v_lines || public._frag(case when (a ->> 'luggage')::boolean then 'ride_edit.luggage_on' else 'ride_edit.luggage_off' end);
  end if;
  if (b ->> 'ride_type') is distinct from (a ->> 'ride_type') then
    v_lines := v_lines || public._frag('ride_edit.ride_type', jsonb_build_object('new', a ->> 'ride_type', 'old', b ->> 'ride_type'));
  end if;
  if (b ->> 'notes') is distinct from (a ->> 'notes') then
    v_lines := v_lines || case when coalesce(a ->> 'notes', '') = '' then public._frag('ride_edit.note_cleared')
      else public._frag('ride_edit.note', jsonb_build_object('note', a ->> 'notes')) end;
  end if;
  if (b ->> 'description') is distinct from (a ->> 'description') and coalesce(a ->> 'description', '') <> '' then
    v_lines := v_lines || public._frag('ride_edit.description', jsonb_build_object('text', a ->> 'description'));
  end if;
  return v_lines;
end $$;

-- (c)/(f) This call is a save from the request form, not on the Sadran board.
create or replace function public._ride_edit_notice_applies() returns boolean
  language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_headers json;
begin
  if (select auth.uid()) is null then return false; end if;
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    return false;
  end;
  return coalesce(v_headers ->> 'x-request-form', '') = '1'
     and coalesce(v_headers ->> 'x-app-surface', '') <> 'board';
end $$;

create or replace function public._ride_edit_pending() returns boolean
  language sql stable set search_path = public, pg_temp as $$
  select coalesce(nullif(current_setting('app.ride_edit_before', true), ''), '{}') <> '{}';
$$;

-- (c) Remember a request's state before the transaction's first change to it (the first call wins).
create or replace function public._ride_edit_capture(p_request uuid) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_map jsonb := coalesce(nullif(current_setting('app.ride_edit_before', true), ''), '{}')::jsonb;
begin
  if p_request is null or v_map ? p_request::text or not public._ride_edit_notice_applies() then return; end if;
  perform set_config('app.ride_edit_before',
    (v_map || jsonb_build_object(p_request::text, public._ride_edit_snapshot(p_request)))::text, true);
end $$;

-- (c)/(d) Tell each rider (before or after) what changed, folding in their unread notice of the same request.
create or replace function public._notify_ride_edited(p_request uuid, p_before jsonb) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := (select auth.uid());
  q public.requests%rowtype;
  v_after jsonb;
  v_to uuid;
  v_old record;
  v_old_ids uuid[];
  v_base jsonb;
  v_editors jsonb;
  v_lines text[];
  v_notif uuid;
  v_actor_name text;
begin
  select * into q from public.requests where id = p_request;
  if q.id is null or v_actor is null or p_before is null then return; end if;
  v_after := public._ride_edit_snapshot(p_request);
  -- a call of the same save that changed nothing a rider sees (e.g. the repeat-weekly template) re-sends nothing
  if v_after = p_before then return; end if;
  select full_name into v_actor_name from public.profiles where id = v_actor;
  for v_to in
    select distinct x::uuid from jsonb_array_elements_text(coalesce(p_before -> 'recipients', '[]') || coalesce(v_after -> 'recipients', '[]')) x
    where x::uuid <> v_actor
  loop
    -- the form saves companions and children in parallel: one merge at a time per rider and request
    perform pg_advisory_xact_lock(hashtextextended(format('ride_edited:%s:%s', p_request, v_to), 0));
    v_base := p_before; v_editors := '[]'::jsonb; v_old_ids := null;
    for v_old in
      select n.id, n.data from public.notifications n
      where n.recipient_id = v_to and n.event = 'ride_edited' and n.read_at is null and n.data ->> 'request_id' = p_request::text
      order by n.created_at, n.id
    loop
      if v_old_ids is null and v_old.data ? 'before' then v_base := v_old.data -> 'before'; end if;
      v_old_ids := array_append(v_old_ids, v_old.id);
      v_editors := v_editors || coalesce(v_old.data -> 'editors', '[]'::jsonb);
    end loop;
    v_editors := v_editors || to_jsonb(array[coalesce(v_actor_name, '')]);
    select coalesce(jsonb_agg(nm order by o), '[]'::jsonb) into v_editors
    from (select nm, min(o) as o from jsonb_array_elements_text(v_editors) with ordinality u(nm, o) group by nm) x;
    if v_old_ids is not null then
      delete from public.notifications where id = any(v_old_ids);   -- their outbox rows go with them (cascade)
    end if;
    v_lines := public._ride_edit_lines(v_base, v_after);
    continue when coalesce(cardinality(v_lines), 0) = 0;   -- edited back to what the rider last saw
    v_notif := public.enqueue_notification(v_to, 'ride_edited', q.department_id, q.week_start,
      jsonb_build_object(
        'byName', public._and_list(array(select jsonb_array_elements_text(v_editors))),
        'route', coalesce(v_after ->> 'route', ''),
        'day', public.day_date_label(coalesce(q.depart_at, q.return_at)),
        'changes', array_to_string(v_lines, ' · ')),
      jsonb_build_object('request_id', p_request, 'before', v_base, 'editors', v_editors)
        -- a rider taken off the request no longer sees it: their link is the week's siddur
        || case when v_after -> 'recipients' ? v_to::text then '{}'::jsonb
                else jsonb_build_object('url', format('/siddur/%s/%s', q.department_id, q.week_start)) end,
      format('ride_edited:%s:%s:%s', p_request, v_to, clock_timestamp()));
    if v_notif is not null then
      if coalesce((select p.push_on_ride_edits from public.profiles p where p.id = v_to), true) then
        update public.push_outbox set payload = payload || jsonb_build_object('tag', format('replace:ride_edited:%s', p_request))
        where notification_id = v_notif;
      else
        delete from public.push_outbox where notification_id = v_notif;   -- (e) inbox only
      end if;
    end if;
  end loop;
end $$;

-- At commit: every request captured in this transaction is told once.
create or replace function public._ride_edit_flush() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_map jsonb := coalesce(nullif(current_setting('app.ride_edit_before', true), ''), '{}')::jsonb;
  v_key text;
begin
  if v_map = '{}'::jsonb then return null; end if;
  perform set_config('app.ride_edit_before', '{}', true);
  for v_key in select k from jsonb_object_keys(v_map) k order by k loop
    perform public._notify_ride_edited(v_key::uuid, v_map -> v_key);
  end loop;
  return null;
end $$;

-- Companions and children are saved by their own calls (set_request_companions / set_request_children).
create or replace function public._ride_edit_capture_row() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._ride_edit_capture(case when tg_op = 'DELETE' then old.request_id else new.request_id end);
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create or replace function public._ride_edit_capture_request() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._ride_edit_capture(old.id);
  return new;
end $$;

create trigger requests_ride_edit_capture before update on public.requests
  for each row when (public._ride_edit_notice_applies()) execute function public._ride_edit_capture_request();
create trigger request_companions_ride_edit_capture before insert or delete on public.request_companions
  for each row when (public._ride_edit_notice_applies()) execute function public._ride_edit_capture_row();
create trigger request_children_ride_edit_capture before insert or delete on public.request_children
  for each row when (public._ride_edit_notice_applies()) execute function public._ride_edit_capture_row();

create constraint trigger requests_ride_edit_notify after update on public.requests
  deferrable initially deferred for each row when (public._ride_edit_pending()) execute function public._ride_edit_flush();
create constraint trigger request_companions_ride_edit_notify after insert or delete on public.request_companions
  deferrable initially deferred for each row when (public._ride_edit_pending()) execute function public._ride_edit_flush();
create constraint trigger request_children_ride_edit_notify after insert or delete on public.request_children
  deferrable initially deferred for each row when (public._ride_edit_pending()) execute function public._ride_edit_flush();

revoke all on function public._and_list(text[]) from public;
revoke all on function public._ride_edit_snapshot(uuid) from public;
revoke all on function public._ride_edit_lines(jsonb, jsonb) from public;
-- the triggers' WHEN clauses run as the writer (request_children has direct member write policies); both only read
-- this call's own settings
revoke all on function public._ride_edit_notice_applies() from public;
revoke all on function public._ride_edit_pending() from public;
grant execute on function public._ride_edit_notice_applies() to authenticated;
grant execute on function public._ride_edit_pending() to authenticated;
revoke all on function public._ride_edit_capture(uuid) from public;
revoke all on function public._notify_ride_edited(uuid, jsonb) from public;
revoke all on function public._ride_edit_flush() from public;
revoke all on function public._ride_edit_capture_row() from public;
revoke all on function public._ride_edit_capture_request() from public;
