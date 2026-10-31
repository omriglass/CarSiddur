-- REQ §13.169: with the department's "anyone edits rides" switch on, any member edits any request in the form; its
-- riders get one `ride_edited` notice listing the changes, folded while unread; the who chip may move the request to
-- the rider who drives; the push follows the rider's `push_on_ride_edits`. Transactional.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  sadran uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  m3 uuid:='00000000-0000-0000-0000-00000000e169';
  dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  w date:=public.current_week_start()+1372;
  pub uuid; d timestamptz; q uuid; res jsonb; body text; n record;
  form_call text:='{"x-request-form":"1"}';
  edit jsonb;
begin
  insert into auth.users(id, email, raw_user_meta_data) values (m3, 'ride-edited-m3@test.local', '{}');
  update public.profiles set approval_status = 'approved', full_name = 'עורך שלישי', does_not_drive = false where id = m3;
  insert into public.department_members(department_id, profile_id, role) values (dept, m3, 'member');
  update public.profiles set does_not_drive = false where id in (m1, m2);
  update public.profiles set push_on_ride_edits = false where id = m2;
  insert into public.push_subscriptions(profile_id, endpoint, p256dh, auth) values
    (m1, 'https://push.test/m1', 'k', 'a'), (m2, 'https://push.test/m2', 'k', 'a');
  update public.department_settings set anyone_edits_rides = false where department_id = dept;

  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  d:=((w+2)+time '08:00') at time zone 'Asia/Jerusalem';

  -- m1 asks for a ride with m2 as a named companion; it is placed (a published day)
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m1,'role','authenticated')::text,true);
  res:=public.submit_request(jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'trip_shape','round_trip','depart_at',d,'return_at',d+interval '3 hours','adults',2,'companion_ids',jsonb_build_array(m2)));
  q:=(res->>'request_id')::uuid;
  set constraints all immediate; set constraints all deferred;
  assert (select status::text from public.requests where id=q) = 'assigned', format('placed first, got %s', res);
  edit:=jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,
    'trip_shape','round_trip','adults',2,'request_id',q);

  -- TEST 1: switch off — an unrelated member may not edit it
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m3,'role','authenticated')::text,true);
  assert not public.can_edit_request(q), 'TEST 1 FAILED: an unrelated member may edit with the switch off';
  begin
    perform public.submit_request(edit || jsonb_build_object('depart_at',d+interval '1 hour','return_at',d+interval '4 hours',
      'expected_version',(select version from public.requests where id=q)));
    raise exception 'TEST 1 FAILED: the edit went through';
  exception when others then
    assert sqlerrm = 'not_authorized', format('TEST 1 FAILED: expected not_authorized, got %s', sqlerrm);
  end;
  raise notice 'TEST 1 PASSED: switch off, an unrelated member cannot edit';

  -- TEST 2: switch on — m3 edits the hours from the form; m1 and m2 each get one notice, m3 none, no older notices
  update public.department_settings set anyone_edits_rides = true where department_id = dept;
  assert public.can_edit_request(q), 'TEST 2 FAILED: the switch does not open editing';
  perform set_config('request.headers', form_call, true);
  res:=public.submit_request(edit || jsonb_build_object('depart_at',d+interval '1 hour','return_at',d+interval '4 hours',
    'expected_version',(select version from public.requests where id=q)));
  set constraints all immediate; set constraints all deferred;
  assert res->>'status'='assigned', format('TEST 2 FAILED: the edit is placed, got %s', res);
  assert (select count(*) from public.notifications where recipient_id=m1 and event='ride_edited' and data->>'request_id'=q::text)=1,
    'TEST 2 FAILED: the requester gets one ride_edited';
  assert (select count(*) from public.notifications where recipient_id=m2 and event='ride_edited' and data->>'request_id'=q::text)=1,
    'TEST 2 FAILED: the companion gets one ride_edited';
  assert not exists (select 1 from public.notifications where recipient_id=m3 and event='ride_edited'), 'TEST 2 FAILED: the editor is told';
  assert not exists (select 1 from public.notifications where data->>'request_id'=q::text and data->>'variant' in ('edit_applied','time_changed','car_changed')),
    'TEST 2 FAILED: the old edit notices were sent too';
  select title_he, body_he into n from public.notifications where recipient_id=m1 and event='ride_edited';
  assert n.title_he like 'עורך שלישי%', format('TEST 2 FAILED: title names the editor, got %s', n.title_he);
  assert n.body_he like '%יציאה 09:00 במקום 08:00%', format('TEST 2 FAILED: body lists the hours, got %s', n.body_he);
  assert exists (select 1 from public.push_outbox o join public.notifications x on x.id=o.notification_id
                 where x.recipient_id=m1 and x.event='ride_edited' and o.payload->>'tag'=format('replace:ride_edited:%s', q)),
    'TEST 2 FAILED: the requester is pushed with a replace tag';
  assert not exists (select 1 from public.push_outbox o join public.notifications x on x.id=o.notification_id
                     where x.recipient_id=m2 and x.event='ride_edited'), 'TEST 2 FAILED: push off still pushed';
  raise notice 'TEST 2 PASSED: one notice per rider, editor not told, old notices not sent, push per rider';

  -- TEST 3: a second edit while unread folds into the same notice, from what the rider last saw
  res:=public.submit_request(edit || jsonb_build_object('depart_at',d+interval '2 hours','return_at',d+interval '5 hours',
    'expected_version',(select version from public.requests where id=q)));
  set constraints all immediate; set constraints all deferred;
  assert (select count(*) from public.notifications where recipient_id=m1 and event='ride_edited')=1, 'TEST 3 FAILED: a second notice';
  select body_he into body from public.notifications where recipient_id=m1 and event='ride_edited';
  assert body like '%יציאה 10:00 במקום 08:00%', format('TEST 3 FAILED: folded from the first state, got %s', body);
  raise notice 'TEST 3 PASSED: unread notice folded';

  -- TEST 4: m1 reads it; editing back gives m1 a new one, while m2 (unread, back where they started) has none left
  update public.notifications set read_at=now() where recipient_id=m1 and event='ride_edited';
  res:=public.submit_request(edit || jsonb_build_object('depart_at',d,'return_at',d+interval '3 hours',
    'expected_version',(select version from public.requests where id=q)));
  set constraints all immediate; set constraints all deferred;
  assert (select count(*) from public.notifications where recipient_id=m1 and event='ride_edited' and read_at is null)=1,
    'TEST 4 FAILED: the reader gets a new notice';
  select body_he into body from public.notifications where recipient_id=m1 and event='ride_edited' and read_at is null;
  assert body like '%יציאה 08:00 במקום 10:00%', format('TEST 4 FAILED: from what was read, got %s', body);
  assert not exists (select 1 from public.notifications where recipient_id=m2 and event='ride_edited'),
    'TEST 4 FAILED: an edit undone before it was read still shows';
  raise notice 'TEST 4 PASSED: read notices stay, an undone edit disappears';

  -- TEST 5: the who chip moves the request to m2, who drives; m1 stays as a rider and is told who drives now
  update public.notifications set read_at=now() where recipient_id=m1 and event='ride_edited';
  res:=public.submit_request(edit || jsonb_build_object('depart_at',d,'return_at',d+interval '3 hours','requester_id',m2,
    'companion_ids',jsonb_build_array(m1),'expected_version',(select version from public.requests where id=q)));
  set constraints all immediate; set constraints all deferred;
  assert res->>'status'='assigned', format('TEST 5 FAILED: the moved request is placed, got %s', res);
  assert (select requester_id from public.requests where id=q)=m2, 'TEST 5 FAILED: requester not moved';
  assert exists (select 1 from public.request_companions where request_id=q and profile_id=m1)
     and not exists (select 1 from public.request_companions where request_id=q and profile_id=m2),
    'TEST 5 FAILED: companions not swapped';
  assert (select r.driver_id from public.ride_requests rr join public.rides r on r.id=rr.ride_id
          where rr.request_id=q and r.status<>'cancelled' order by r.starts_at limit 1)=m2, 'TEST 5 FAILED: m2 does not drive';
  select body_he into body from public.notifications where recipient_id=m1 and event='ride_edited' and read_at is null;
  assert body like '%נהג/ת: חברה שנייה במקום חבר ראשון%', format('TEST 5 FAILED: driver line, got %s', body);
  raise notice 'TEST 5 PASSED: the who chip moves the request to the driver';

  -- TEST 7: the form saves companions by their own call — a rider taken off is told, with a link that still opens
  update public.notifications set read_at=now() where event='ride_edited';
  perform public.set_request_companions(q, '{}'::uuid[]);
  set constraints all immediate; set constraints all deferred;
  select body_he, data into n from public.notifications where recipient_id=m1 and event='ride_edited' and read_at is null;
  assert n.body_he like '%ירדו מהנסיעה: חבר ראשון%', format('TEST 7 FAILED: removal line, got %s', n.body_he);
  assert n.data->>'url' like '/siddur/%', format('TEST 7 FAILED: a removed rider links to the siddur, got %s', n.data->>'url');
  assert exists (select 1 from public.notifications where recipient_id=m2 and event='ride_edited' and read_at is null),
    'TEST 7 FAILED: the requester is told';
  raise notice 'TEST 7 PASSED: companion changes from their own call are told';

  -- TEST 6: without the form header (another screen) the old notices stay and no ride_edited is sent
  perform set_config('request.headers', '{}', true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',m2,'role','authenticated')::text,true);
  update public.notifications set read_at=now() where event='ride_edited';
  insert into public.request_companions(request_id, profile_id) values (q, m1);
  res:=public.submit_request(edit || jsonb_build_object('depart_at',d+interval '1 hour','return_at',d+interval '4 hours','requester_id',m2,
    'expected_version',(select version from public.requests where id=q)));
  set constraints all immediate; set constraints all deferred;
  assert not exists (select 1 from public.notifications where event='ride_edited' and read_at is null), 'TEST 6 FAILED: ride_edited without the form';
  assert exists (select 1 from public.notifications where recipient_id=m1 and data->>'variant'='time_changed' and data->>'request_id'=q::text),
    'TEST 6 FAILED: the companion hours notice is gone';
  raise notice 'TEST 6 PASSED: other screens keep their notices';

  set constraints all immediate;
end $$;
rollback;
