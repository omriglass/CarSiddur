-- R16B8 (QA run 16): open merges onto one ride share its seats.
--   (a) one merge draft (1 adult + 2 child seats) fits a car with 2 child seats
--   (b) a second guest needing 2 more child seats is refused by _merge_check and create_proposal while the first is open
--   (c) once the first draft is discarded, the second fits again
-- Transactional (begin ... rollback).
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001';
  admin_id uuid:='00000000-0000-0000-0000-000000000101';
  sadran uuid:='00000000-0000-0000-0000-000000000102';
  m1 uuid:='00000000-0000-0000-0000-000000000103';
  m2 uuid:='00000000-0000-0000-0000-000000000104';
  home uuid:='00000000-0000-0000-0000-000000000010';
  dest uuid:='00000000-0000-0000-0000-000000000011';
  typ uuid:='00000000-0000-0000-0000-000000000021';
  carA uuid:='00000000-0000-0000-0000-000000000040';
  w date:=public.current_week_start()+1365;
  dt timestamptz; pub uuid; qh uuid; q2 uuid; q3 uuid; rA uuid; p uuid; res jsonb;
begin
  dt:=((w+2)+time '08:00') at time zone 'Asia/Jerusalem';
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
  values(dept,w,'solving',now()-interval '9 days',now()-interval '8 days',now()-interval '7 days');
  insert into public.siddur_versions(department_id,week_start,snapshot,published_by) values(dept,w,'{}',sadran) returning id into pub;
  perform set_config('app.in_publish','on',true);
  update public.weeks set phase='published',published_version_id=pub,published_days=array[w,w+1,w+2,w+3,w+4,w+5,w+6] where department_id=dept and week_start=w;
  perform set_config('app.in_publish','off',true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sadran,'role','authenticated')::text,true);

  -- the car: 5 adults, 2 child seats
  delete from public.car_seat_configs where car_id=carA;
  insert into public.car_seat_configs(car_id,adults,child_seats,boosters) values(carA,5,2,0);

  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status)
    values(dept,w,m1,m1,dest,typ,dt,dt+interval '4 hours','round_trip','assigned') returning id into qh;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,driver_id,status,is_pinned,pin_reason,created_by)
    values(dept,w,carA,dt,dt+interval '4 hours',home,home,m1,'confirmed',true,'SADRAN_MANUAL',sadran) returning id into rA;
  insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values(rA,qh,'driver','both','keep');
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,adults,child_seats)
    values(dept,w,m2,m2,dest,typ,dt,dt+interval '4 hours','round_trip','waitlisted',1,2) returning id into q2;
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,trip_shape,status,adults,child_seats)
    values(dept,w,admin_id,admin_id,dest,typ,dt,dt+interval '4 hours','round_trip','waitlisted',1,2) returning id into q3;
  set constraints all immediate; set constraints all deferred;

  -- ===== (a) the first guest fits ===========================================================================
  res:=public._merge_check(rA,q2,'both');
  assert (res->>'ok')::boolean, format('(a) the first guest fits, got %s', res);
  p:=public.create_proposal(q2,rA,'merge',jsonb_build_object('ride_id',rA,'legs',
       jsonb_build_array(jsonb_build_object('ride_id',rA,'leg','both'))),'',array[]::uuid[]);
  set constraints all immediate; set constraints all deferred;
  assert (select status::text from public.proposals where id=p)='draft', '(a) the first merge is a draft';

  -- ===== (b) the second guest no longer fits while the first draft is open ==================================
  res:=public._merge_check(rA,q3,'both');
  assert not (res->>'ok')::boolean and res->>'code'='seats', format('(b) the second guest is refused for seats, got %s', res);
  begin
    perform public.create_proposal(q3,rA,'merge',jsonb_build_object('ride_id',rA,'legs',
      jsonb_build_array(jsonb_build_object('ride_id',rA,'leg','both'))),'',array[]::uuid[]);
    raise exception 'a stacked merge unexpectedly created';
  exception when others then
    assert sqlerrm<>'a stacked merge unexpectedly created', '(b) create_proposal refuses the stacked merge';
  end;
  -- the probe leaves nothing behind
  assert not exists (select 1 from public.ride_requests where ride_id=rA and request_id in (q2,q3)), '(b) the probe is rolled back';

  -- ===== (c) the first draft is discarded: the second fits again ============================================
  perform public.discard_proposal(p);
  set constraints all immediate; set constraints all deferred;
  res:=public._merge_check(rA,q3,'both');
  assert (res->>'ok')::boolean, format('(c) with the first draft gone the second fits, got %s', res);

  -- ===== (d) PF1: the seat check reads only, and agrees with the real write ================================
  declare v_audit bigint; v_pure text; v_real text; g uuid; l text;
  begin
    assert (select provolatile from pg_proc where oid='public._merge_check(uuid,uuid,public.ride_leg)'::regprocedure)='s',
      '(d) _merge_check is STABLE: it cannot write';
    select count(*) into v_audit from public.audit_log;
    perform public._merge_check(rA,q3,'both'); perform public._merge_check(rA,q2,'out');
    assert (select count(*) from public.audit_log)=v_audit, '(d) a merge check leaves no audit rows';
    foreach g in array array[q2,q3] loop
      foreach l in array array['out','return','both'] loop
        v_pure:=public.ride_seats_verdict(rA,jsonb_build_array(jsonb_build_object('request_id',g,'leg',l)));
        v_real:=null;
        begin
          delete from public.ride_requests where request_id=g and ride_id<>rA;
          insert into public.ride_requests(ride_id,request_id,role,leg,car_mode) values (rA,g,'passenger',l::public.ride_leg,'passenger');
          perform public.assert_ride_seats_fit(rA);
          raise exception 'probe_ok';
        exception when others then
          if sqlerrm in ('seat_config_violation','luggage_capacity_violation','needs_large_trunk') then v_real:=sqlerrm; end if;
        end;
        assert v_pure is not distinct from v_real, format('(d) ride_seats_verdict = the real write for %s %s: %s vs %s', g, l, v_pure, v_real);
      end loop;
    end loop;
  end;

  set constraints all immediate;
  raise notice 'merge_open_merges_seats.sql: all R16B8 assertions passed';
end $$;
rollback;
