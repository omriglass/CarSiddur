-- REQ §13.155 (owner 2026-10-26): in a partly published week, a day not published yet takes no member requests or
-- edits (`day_not_published`); a published day still does, and the week's Sadran may file on either. Transactional.
begin;
do $$
declare dept uuid:='00000000-0000-0000-0000-000000000001'; sadran uuid:='00000000-0000-0000-0000-000000000102';
  member uuid:='00000000-0000-0000-0000-000000000103'; dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021'; w date:=public.current_week_start()+217;
  base jsonb; res jsonb; q uuid; pub uuid; refused boolean;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'solving',now()-interval '10 days',now()-interval '5 days',now()-interval '4 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w+1] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  base:=jsonb_build_object('department_id',dept,'week_start',w,'destination_id',dest,'ride_type_id',typ,'trip_type','round_trip','adults',1);

  perform set_config('request.jwt.claims',format('{"sub":"%s","role":"authenticated"}',member),true);
  refused:=false;
  begin
    perform public.submit_request(base||jsonb_build_object('depart_at',((w+2)+time '09:00') at time zone 'Asia/Jerusalem',
      'return_at',((w+2)+time '12:00') at time zone 'Asia/Jerusalem'));
  exception when others then
    assert sqlerrm='day_not_published', format('TEST 1 FAILED: expected day_not_published, got %s', sqlerrm);
    refused:=true;
  end;
  assert refused, 'TEST 1 FAILED: a member filed a request on an unpublished day of a published week';
  raise notice 'TEST 1 PASSED: a member cannot file on an unpublished day';

  res:=public.submit_request(base||jsonb_build_object('depart_at',((w+1)+time '09:00') at time zone 'Asia/Jerusalem',
    'return_at',((w+1)+time '12:00') at time zone 'Asia/Jerusalem'));
  q:=(res->>'request_id')::uuid;
  assert q is not null, 'TEST 2 FAILED: a member could not file on a published day';
  raise notice 'TEST 2 PASSED: a member files on a published day (status %)', res->>'status';

  refused:=false;
  begin
    perform public.submit_request(base||jsonb_build_object('request_id',q,'depart_at',((w+2)+time '09:00') at time zone 'Asia/Jerusalem',
      'return_at',((w+2)+time '12:00') at time zone 'Asia/Jerusalem'));
  exception when others then
    assert sqlerrm='day_not_published', format('TEST 3 FAILED: expected day_not_published, got %s', sqlerrm);
    refused:=true;
  end;
  assert refused, 'TEST 3 FAILED: a member moved a request onto an unpublished day';
  raise notice 'TEST 3 PASSED: a member cannot move a request onto an unpublished day';

  perform set_config('request.jwt.claims',format('{"sub":"%s","role":"authenticated"}',sadran),true);
  res:=public.submit_request(base||jsonb_build_object('requester_id',sadran,'depart_at',((w+2)+time '13:00') at time zone 'Asia/Jerusalem',
    'return_at',((w+2)+time '15:00') at time zone 'Asia/Jerusalem'));
  assert res->>'request_id' is not null, 'TEST 4 FAILED: the Sadran could not file on an unpublished day';
  raise notice 'TEST 4 PASSED: the week''s Sadran still files on an unpublished day';
end $$;
rollback;
