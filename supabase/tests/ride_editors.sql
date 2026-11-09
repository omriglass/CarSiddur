-- REQ §13.202: "מי יכול/ה לערוך את הנסיעות שלי" - a member names editors of their requests and rides (per department).
-- 103 names 104: 104 reads 103's unpublished requests, may edit them (request_related / can_edit_request), withdraws a
-- request and cancels a ride through the editor RPCs, and 103 is told each time. 104 gets one inbox message (no push).
-- Transactional fixture; safe against an existing seeded database.
begin;
create function pg_temp.as_user(_id uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', _id, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.expect_err(_sql text, _code text) returns void language plpgsql as $$
begin
  execute _sql;
  raise exception 'expected % from: %', _code, _sql;
exception when others then
  if sqlerrm <> _code then raise exception 'expected %, got % from: %', _code, sqlerrm, _sql; end if;
end $$;
create function pg_temp.at(_d int, _t time) returns timestamptz language sql as $$
  select ((public.current_week_start() + 42 + _d) + _t) at time zone 'Asia/Jerusalem';
$$;
create temporary table re_ids(k text primary key, id uuid);
grant select on re_ids to authenticated;

do $$
declare w date := public.current_week_start() + 42; v uuid; q uuid; q2 uuid; r uuid;
  owner uuid := '00000000-0000-0000-0000-000000000103'; editor uuid := '00000000-0000-0000-0000-000000000104';
begin
  -- a published week (days 0-2) with 103's ride on day 1, and an open request of 103 on an unpublished day 5
  insert into public.weeks(department_id, week_start, phase, open_at, close_at, publish_at)
  values ('00000000-0000-0000-0000-000000000001', w, 'open', now() - interval '1 day', now() + interval '1 day', now() + interval '2 days');
  insert into public.siddur_versions(department_id, week_start, snapshot, published_by)
  values ('00000000-0000-0000-0000-000000000001', w, '{}', '00000000-0000-0000-0000-000000000102') returning id into v;
  perform set_config('app.in_publish', 'on', true);
  update public.weeks set published_days = array[w, w + 1, w + 2], phase = 'published', published_version_id = v
  where week_start = w and department_id = '00000000-0000-0000-0000-000000000001';
  perform set_config('app.in_publish', 'off', true);
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, depart_at, return_at, status, origin_id)
  values ('00000000-0000-0000-0000-000000000001', w, owner, owner, '00000000-0000-0000-0000-000000000011',
    '00000000-0000-0000-0000-000000000021', pg_temp.at(1, '08:00'), pg_temp.at(1, '12:00'), 'assigned', '00000000-0000-0000-0000-000000000010') returning id into q;
  insert into public.rides(department_id, week_start, car_id, starts_at, ends_at, origin_id, destination_id, driver_id, status, created_by)
  values ('00000000-0000-0000-0000-000000000001', w, '00000000-0000-0000-0000-000000000041', pg_temp.at(1, '08:00'), pg_temp.at(1, '12:00'),
    '00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000010', owner, 'confirmed', '00000000-0000-0000-0000-000000000102') returning id into r;
  insert into public.ride_requests(ride_id, request_id, role, leg, car_mode) values (r, q, 'driver', 'both', 'keep');
  insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, depart_at, return_at, status, origin_id)
  values ('00000000-0000-0000-0000-000000000001', w, owner, owner, '00000000-0000-0000-0000-000000000011',
    '00000000-0000-0000-0000-000000000021', pg_temp.at(5, '08:00'), pg_temp.at(5, '12:00'), 'submitted', '00000000-0000-0000-0000-000000000010') returning id into q2;
  insert into re_ids values ('ride', r), ('placed', q), ('open', q2);

  -- (1) before being named: no rights, nothing readable
  assert not public.request_related(q2, editor), 'not an editor yet';
  perform pg_temp.as_user(editor);
  execute 'set local role authenticated';
  assert not exists (select 1 from public.requests where id = q2), 'unpublished request hidden before';
  execute 'reset role';

  -- (2) set_ride_editors: refuses myself and a non-member; adds 104 with one inbox message, no push
  perform pg_temp.as_user(owner);
  perform pg_temp.expect_err(format('select public.set_ride_editors(%L, array[%L]::uuid[])', '00000000-0000-0000-0000-000000000001', owner), 'ride_editor_invalid');
  perform pg_temp.expect_err(format('select public.set_ride_editors(%L, array[%L]::uuid[])', '00000000-0000-0000-0000-000000000001', gen_random_uuid()), 'ride_editor_invalid');
  insert into public.push_subscriptions(profile_id, endpoint, p256dh, auth) values (editor, 'https://push.example/re', 'k', 'a');
  perform public.set_ride_editors('00000000-0000-0000-0000-000000000001', array[editor]);
  perform public.set_ride_editors('00000000-0000-0000-0000-000000000001', array[editor]);   -- unchanged: no second message
  assert (select count(*) from public.notifications where recipient_id = editor and event = 'ride_editor_added') = 1, 'one message';
  assert (select title_he not like '%{{%' and body_he not like '%{{%' from public.notifications where recipient_id = editor and event = 'ride_editor_added'), 'rendered';
  assert not exists (select 1 from public.push_outbox o join public.notifications n on n.id = o.notification_id
                     where n.recipient_id = editor and n.event = 'ride_editor_added'), 'inbox only';

  -- (3) rights: related to 103's requests and rides, can_edit_request, the unpublished request and its stops readable
  assert public.request_related(q2, editor) and public.ride_related(r, editor), 'editor is related';
  assert not public.request_related(q2, '00000000-0000-0000-0000-000000000102'), 'others still are not';
  perform pg_temp.as_user(editor);
  assert public.can_edit_request(q2), 'can_edit_request';
  execute 'set local role authenticated';
  assert exists (select 1 from public.requests where id = (select id from re_ids where k = 'open')), 'unpublished request readable';
  assert exists (select 1 from public.ride_editors), 'the editor sees who named them';
  execute 'reset role';
  -- the owner's list is theirs: 102 sees neither row
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000102');
  execute 'set local role authenticated';
  assert not exists (select 1 from public.ride_editors where owner_id = '00000000-0000-0000-0000-000000000103'), 'others do not see the list';
  execute 'reset role';

  -- (4) another department: the grant does not reach it, and a non-editor may not use the editor RPCs
  assert not public._is_ride_editor('00000000-0000-0000-0000-000000000002', owner, editor), 'per department';
  perform pg_temp.as_user('00000000-0000-0000-0000-000000000102');
  perform pg_temp.expect_err(format('select public.ride_editor_withdraw_request(%L, %s)', q2, (select version from public.requests where id = q2)), 'not_authorized');
  perform pg_temp.expect_err(format('select public.ride_editor_cancel_ride(%L, %L, %s)', r, 'x', (select version from public.rides where id = r)), 'not_authorized');

  -- (5) the editor withdraws the open request: done as the owner, the owner is told who did it
  perform pg_temp.as_user(editor);
  perform public.ride_editor_withdraw_request(q2, (select version from public.requests where id = q2));
  assert (select status from public.requests where id = q2) = 'withdrawn', 'withdrawn';
  assert (select auth.uid()) = editor, 'the caller is restored';
  assert exists (select 1 from public.notifications where recipient_id = owner and event = 'ride_edited'
                 and data ->> 'variant' = 'editor_withdrew' and title_he like '%חברה שנייה%'), 'owner told (withdraw)';

  -- (6) the editor cancels the owner's ride
  perform public.ride_editor_cancel_ride(r, 'EDITOR_CANCELLED', (select version from public.rides where id = r));
  assert (select status from public.rides where id = r) = 'cancelled', 'ride cancelled';
  assert (select auth.uid()) = editor, 'the caller is restored (cancel)';
  assert exists (select 1 from public.notifications where recipient_id = owner and event = 'ride_edited'
                 and data ->> 'variant' = 'editor_cancelled'), 'owner told (cancel)';

  -- (7) removing the editor takes the rights away, silently
  perform pg_temp.as_user(owner);
  perform public.set_ride_editors('00000000-0000-0000-0000-000000000001', '{}');
  assert not public.request_related(q, editor), 'rights gone';
  assert (select count(*) from public.notifications where recipient_id = editor and event = 'ride_editor_added') = 1, 'no message on removal';
  -- a member who left the department is no longer an editor
  perform public.set_ride_editors('00000000-0000-0000-0000-000000000001', array[editor]);
  update public.department_members set removed_at = now() where profile_id = editor and department_id = '00000000-0000-0000-0000-000000000001';
  assert not public._is_ride_editor('00000000-0000-0000-0000-000000000001', owner, editor), 'removed member is not an editor';

  -- (8) REQ §13.202 (i): sharing a child is enough, both ways, in that child's department only; it ends with the link
  declare kid uuid; coparent uuid := '00000000-0000-0000-0000-000000000101';
  begin
    assert not public._is_ride_editor('00000000-0000-0000-0000-000000000001', owner, coparent), 'no child yet';
    insert into public.children(department_id, full_name) values ('00000000-0000-0000-0000-000000000001', 'ילד משותף') returning id into kid;
    insert into public.child_guardians(child_id, profile_id) values (kid, owner), (kid, coparent);
    assert public._is_ride_editor('00000000-0000-0000-0000-000000000001', owner, coparent), 'co-parent edits mine';
    assert public._is_ride_editor('00000000-0000-0000-0000-000000000001', coparent, owner), 'and I edit theirs';
    assert public.request_related(q2, coparent), 'co-parent is related to my requests';
    assert not public._is_ride_editor('00000000-0000-0000-0000-000000000002', owner, coparent), 'only in the child''s department';
    perform pg_temp.as_user(coparent);
    assert exists (select 1 from public.my_ride_editor_links() l where l.person_id = owner and l.direction = 'granted' and l.co_parent and not l.named), 'listed as granted (co-parent)';
    assert exists (select 1 from public.my_ride_editor_links() l where l.person_id = owner and l.direction = 'mine' and l.co_parent), 'listed as mine (co-parent)';
    assert not exists (select 1 from public.notifications where recipient_id = coparent and event = 'ride_editor_added'), 'no message for a co-parent';
    -- (j) a guardian reads (never edits) a request someone else filed with their child on it
    insert into public.requests(department_id, week_start, requester_id, filed_by, destination_id, ride_type_id, depart_at, return_at, status, origin_id)
    values ('00000000-0000-0000-0000-000000000001', w, '00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000011',
      '00000000-0000-0000-0000-000000000021', pg_temp.at(4, '08:00'), pg_temp.at(4, '12:00'), 'submitted', '00000000-0000-0000-0000-000000000010') returning id into q;
    insert into public.request_children(request_id, child_id) values (q, kid);
    insert into re_ids values ('kid_request', q);
    execute 'set local role authenticated';
    assert exists (select 1 from public.requests where id = (select id from re_ids where k = 'kid_request')), 'guardian reads the child''s request';
    assert exists (select 1 from public.request_children where request_id = (select id from re_ids where k = 'kid_request')), 'and who is on it';
    execute 'reset role';
    assert not public.request_related(q, coparent), 'reading is not editing';
    perform pg_temp.as_user('00000000-0000-0000-0000-000000000104');
    execute 'set local role authenticated';
    assert not exists (select 1 from public.requests where id = (select id from re_ids where k = 'kid_request')), 'not for someone who is not a guardian';
    execute 'reset role';
    perform pg_temp.as_user(coparent);
    delete from public.child_guardians where child_id = kid and profile_id = coparent;
    assert not public._is_ride_editor('00000000-0000-0000-0000-000000000001', owner, coparent), 'rights end with the shared child';
  end;
  raise notice 'ride_editors.sql: all assertions passed';
end $$;

rollback;
