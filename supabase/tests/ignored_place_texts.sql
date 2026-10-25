-- REQ §13.152: the admin's free-text queue — ignored place texts (RLS, one row per normalized text) and linking waiting
-- requests when an approved place is CREATED (before, only an update linked them).
-- Transactional (rolled back). Latin fixture names on purpose: no Hebrew in SQL.
begin;

create function pg_temp.act_as(_id uuid) returns void
language sql as $$ select set_config('request.jwt.claims', jsonb_build_object('sub', _id, 'role', 'authenticated')::text, true) $$;

create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to authenticated;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  w_open date := public.current_week_start() + 434;
  w_arch date := public.current_week_start() + 441;
  r_wait uuid; r_arch uuid; r_asg uuid; p_new uuid;
begin
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at) values
    (dept, w_open, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days'),
    (dept, w_arch, 'archived', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_text, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w_open, '00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000103', '  newtown  ',
    '00000000-0000-0000-0000-000000000021', 'round_trip', ((w_open + 2) + time '08:00') at time zone 'Asia/Jerusalem',
    ((w_open + 2) + time '16:00') at time zone 'Asia/Jerusalem', 1, now(), 'submitted')
  returning id into r_wait;
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_text, ride_type_id,
    trip_shape, depart_at, return_at, adults, submitted_at, status)
  values (dept, w_arch, '00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000103', 'NewTown',
    '00000000-0000-0000-0000-000000000021', 'round_trip', ((w_arch + 2) + time '08:00') at time zone 'Asia/Jerusalem',
    ((w_arch + 2) + time '16:00') at time zone 'Asia/Jerusalem', 1, now(), 'submitted')
  returning id into r_arch;

  -- (b) creating an approved place links the waiting request; an archived week keeps its text
  insert into public.destinations(department_id, name, aliases, zone, is_approved) values (dept, 'Newtown', '{}', 'north', true)
    returning id into p_new;
  assert (select destination_id = p_new and destination_text is null from public.requests where id = r_wait),
    '(b) creating an approved place must link a waiting request with the same typed text';
  assert (select destination_id is null and destination_text = 'NewTown' from public.requests where id = r_arch),
    '(b) a request in an archived week keeps its text';
  -- an unapproved new place links nothing
  update public.requests set destination_id = null, destination_text = 'Draftplace' where id = r_wait;
  insert into public.destinations(department_id, name, aliases, zone, is_approved) values (dept, 'Draftplace', '{}', 'north', false);
  assert (select destination_id is null from public.requests where id = r_wait), '(b) an unapproved new place must not link';
  raise notice 'PASS (b) creating an approved place links waiting requests';
end $$;

-- (a) RLS: the Sadran / admin ignore and undo; a member neither sees nor writes; the key is the normalized text
select pg_temp.act_as('00000000-0000-0000-0000-000000000102');
set local role authenticated;
insert into public.ignored_place_texts(department_id, text) values ('00000000-0000-0000-0000-000000000001', '  Kfar   Typo ');
do $$ begin
  assert (select text_key = 'kfar typo' and created_by = '00000000-0000-0000-0000-000000000102'
          from public.ignored_place_texts where department_id = '00000000-0000-0000-0000-000000000001'),
    '(a) the Sadran ignores a text; text_key is normalized; created_by is the caller';
  begin
    insert into public.ignored_place_texts(department_id, text) values ('00000000-0000-0000-0000-000000000001', 'kfar typo');
    raise exception '(a) the same normalized text twice must be refused';
  exception when unique_violation then null;
  end;
  begin
    insert into public.ignored_place_texts(department_id, text) values ('00000000-0000-0000-0000-0000000009f9', 'Elsewhere');
    raise exception '(a) another department must be refused';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;
  insert into t_ids values ('ignored', (select id from public.ignored_place_texts where text_key = 'kfar typo'));
end $$;
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-000000000103');
set local role authenticated;
do $$ declare n int; begin
  select count(*) into n from public.ignored_place_texts;
  assert n = 0, '(a) a member must not see ignored texts';
  begin
    insert into public.ignored_place_texts(department_id, text) values ('00000000-0000-0000-0000-000000000001', 'Member text');
    raise exception '(a) a member must not ignore texts';
  exception when insufficient_privilege then null;
  end;
  delete from public.ignored_place_texts where id = (select v from t_ids where k = 'ignored');
  get diagnostics n = row_count;
  assert n = 0, '(a) a member must not undo an ignore';
end $$;
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
set local role authenticated;
do $$ declare n int; begin
  delete from public.ignored_place_texts where id = (select v from t_ids where k = 'ignored');
  get diagnostics n = row_count;
  assert n = 1, '(a) an admin undoes an ignore';
  raise notice 'PASS (a) ignored place texts: Sadran/admin only, normalized, one per text';
end $$;
reset role;

rollback;
