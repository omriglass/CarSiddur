-- REQ §13.137: a typed place that is on the list becomes that place (on save and on approval).
-- Transactional (rolled back). Latin fixture names on purpose: no Hebrew in SQL.
begin;

create function pg_temp.mk_request(p_week date, p_dest_text text, p_origin_text text, p_status text default 'submitted')
returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_text, origin_text,
    ride_type_id, trip_shape, depart_at, return_at, adults, submitted_at, status)
  values ('00000000-0000-0000-0000-000000000001', p_week, '00000000-0000-0000-0000-000000000103',
    '00000000-0000-0000-0000-000000000103', p_dest_text, p_origin_text, '00000000-0000-0000-0000-000000000021',
    'round_trip', ((p_week + 2) + time '08:00') at time zone 'Asia/Jerusalem',
    ((p_week + 2) + time '16:00') at time zone 'Asia/Jerusalem', 1, now(), 'submitted')
  returning id into v;
  if p_status <> 'submitted' then
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = p_status::public.request_status where id = v;
    perform set_config('app.system_status_transition', 'off', true);
  end if;
  return v;
end $$;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  dept2 uuid := '00000000-0000-0000-0000-0000000009f1';
  member1 uuid := '00000000-0000-0000-0000-000000000103';
  home uuid := '00000000-0000-0000-0000-000000000010';
  typ uuid := '00000000-0000-0000-0000-000000000021';
  w_open date := public.current_week_start() + 420;
  w_old date := public.current_week_start() + 427;
  p_ok uuid; p_alias uuid; p_off uuid; p_dup1 uuid; p_dup2 uuid; p_other uuid; p_sug uuid;
  r1 uuid; r2 uuid; r3 uuid; r4 uuid; r5 uuid; r_asg uuid; r_old uuid; t1 uuid; s_open uuid; s_asg uuid; v_ver int;
begin
  insert into public.departments(id, name, slug) values (dept2, 'Other dept', 'other-137');
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at) values
    (dept, w_open, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days'),
    (dept, w_old, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');

  insert into public.destinations(department_id, name, aliases, zone, is_approved) values (dept, 'Linkville', '{}', 'north', true) returning id into p_ok;
  insert into public.destinations(department_id, name, aliases, zone, is_approved) values (dept, 'Aliasburg', array['Ali Town'], 'north', true) returning id into p_alias;
  insert into public.destinations(department_id, name, aliases, zone, is_approved) values (dept, 'Offlist', '{}', 'north', false) returning id into p_off;
  insert into public.destinations(department_id, name, aliases, zone, is_approved) values (dept, 'Twinplace', '{}', 'north', true) returning id into p_dup1;
  insert into public.destinations(department_id, name, aliases, zone, is_approved) values (dept, 'Twin Two', array['twinplace'], 'north', true) returning id into p_dup2;
  insert into public.destinations(department_id, name, aliases, zone, is_approved) values (dept2, 'Elsewhere', '{}', 'north', true) returning id into p_other;

  -- (a) on insert: spaces / case, alias, origin
  r1 := pg_temp.mk_request(w_open, '  linkVILLE ', ' LinkVille  ');
  assert (select destination_id = p_ok and destination_text is null and origin_id = p_ok and origin_text is null
          from public.requests where id = r1), '(a) typed name with extra spaces / other case must link (destination and origin)';
  r2 := pg_temp.mk_request(w_open, 'ali town', null);
  assert (select destination_id = p_alias and destination_text is null from public.requests where id = r2),
    '(a) an alias must link';
  -- unapproved, ambiguous, other department: stay text
  r3 := pg_temp.mk_request(w_open, 'Offlist', 'Elsewhere');
  assert (select destination_id is null and destination_text = 'Offlist' and origin_id is null and origin_text = 'Elsewhere'
          from public.requests where id = r3), '(a) an unapproved place / another department''s place must stay text';
  r4 := pg_temp.mk_request(w_open, 'TWINPLACE', null);
  assert (select destination_id is null and destination_text = 'TWINPLACE' from public.requests where id = r4),
    '(a) a text matching two places must stay text';
  -- an update that changes the typed text links as well
  update public.requests set destination_text = 'Linkville' where id = r4;
  assert (select destination_id = p_ok from public.requests where id = r4), '(a) editing the typed text links on update';

  -- stops and templates on save
  insert into public.request_stops(request_id, department_id, leg, "position", place_text) values (r3, dept, 'out', 1, ' LINKVILLE')
    returning id into s_open;
  assert (select place_id = p_ok and place_text is null from public.request_stops where id = s_open), '(a) stop links on insert';
  insert into public.request_templates(requester_id, department_id, destination_text, origin_text, ride_type_id, depart_dow, depart_time, return_dow, return_time)
    values (member1, dept, 'aliasburg', 'Offlist', typ, 2, '08:00', 2, '16:00') returning id into t1;
  assert (select destination_id = p_alias and destination_text is null and origin_text = 'Offlist' from public.request_templates where id = t1),
    '(a) template destination links, unmatched origin stays text';

  -- (b) approval: suggested place waiting, with open / assigned / archived-week requests
  insert into public.destinations(department_id, name, aliases, zone, is_approved) values (dept, 'Sug Place', '{}', 'unknown', false) returning id into p_sug;
  r5 := pg_temp.mk_request(w_open, 'sug place', 'SUG  PLACE');
  r_asg := pg_temp.mk_request(w_open, 'Sug Place', null, 'assigned');
  r_old := pg_temp.mk_request(w_old, 'Sug Place', null);
  insert into public.request_stops(request_id, department_id, leg, "position", place_text) values (r5, dept, 'out', 1, 'sug place') returning id into s_open;
  insert into public.request_stops(request_id, department_id, leg, "position", place_text) values (r_asg, dept, 'out', 1, 'sug place') returning id into s_asg;
  insert into public.request_templates(requester_id, department_id, destination_text, ride_type_id, depart_dow, depart_time, return_dow, return_time)
    values (member1, dept, 'Sug Place', typ, 3, '08:00', 3, '16:00') returning id into t1;
  update public.weeks set phase = 'archived' where department_id = dept and week_start = w_old;
  select version into v_ver from public.requests where id = r5;

  assert (select destination_id is null from public.requests where id = r5), '(b) precondition: unapproved place does not link';
  update public.destinations set is_approved = true where id = p_sug;

  assert (select destination_id = p_sug and destination_text is null and origin_id = p_sug and origin_text is null and version = v_ver + 1
          from public.requests where id = r5), '(b) approval links an open request''s destination and origin and bumps its version';
  assert (select place_id = p_sug and place_text is null from public.request_stops where id = s_open), '(b) approval links the open request''s stop';
  assert (select destination_id = p_sug and destination_text is null from public.request_templates where id = t1), '(b) approval links the template';
  assert (select destination_id is null and destination_text = 'Sug Place' from public.requests where id = r_asg),
    '(b) an assigned request must stay as typed';
  assert (select place_id is null and place_text = 'sug place' from public.request_stops where id = s_asg),
    '(b) a stop of an assigned request must stay as typed';
  assert (select destination_id is null and destination_text = 'Sug Place' from public.requests where id = r_old),
    '(b) a request in an archived week must stay as typed';

  -- (b) an ambiguous text stays text even when one of the two places is approved last
  update public.destinations set is_approved = false where id = p_dup2;
  r1 := pg_temp.mk_request(w_open, 'Twinplace', null);   -- one approved match -> links on save
  assert (select destination_id = p_dup1 from public.requests where id = r1), '(a) one approved match links';
  r2 := pg_temp.mk_request(w_open, 'Twin Two', null);
  assert (select destination_id is null from public.requests where id = r2), 'unapproved alias place stays text';
  update public.destinations set is_approved = true where id = p_dup2;  -- now "twinplace" matches two places
  r3 := pg_temp.mk_request(w_open, 'twinplace', null);
  assert (select destination_id is null and destination_text = 'twinplace' from public.requests where id = r3),
    '(b) an ambiguous text stays text after approval';

  -- the matcher is not callable by members
  assert not has_function_privilege('authenticated', 'public.match_department_place(uuid,text)', 'execute'),
    'match_department_place must stay internal';
  assert not has_function_privilege('authenticated', 'public.link_typed_places_on_approval()', 'execute'),
    'link_typed_places_on_approval must stay internal';
  raise notice 'place_linking: all assertions passed';
end $$;

rollback;
