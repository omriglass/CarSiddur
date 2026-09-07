-- Exact 23:59 is a supported end; combined proposals cannot cross midnight.
begin;
do $$
declare
  dept uuid:='00000000-0000-0000-0000-000000000001'; manager uuid:='00000000-0000-0000-0000-000000000102';
  member uuid:='00000000-0000-0000-0000-000000000103'; w date:=public.current_week_start()+252;
  ride uuid; request_id uuid; proposal uuid; start_at timestamptz; payload jsonb;
begin
  insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
    values(dept,w,'open',now()-interval '1 day',now()+interval '1 day',now()+interval '2 days');
  start_at:=((w+1)+time '22:00') at time zone 'Asia/Jerusalem';
  insert into public.requests(department_id,week_start,requester_id,filed_by,destination_id,ride_type_id,depart_at,return_at,status)
    values(dept,w,member,member,'00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000021',
      start_at,((w+1)+time '23:59') at time zone 'Asia/Jerusalem','submitted') returning id into request_id;
  insert into public.rides(department_id,week_start,car_id,starts_at,ends_at,origin_id,destination_id,status,created_by,notes)
    values(dept,w,'00000000-0000-0000-0000-000000000040',start_at,start_at+interval '1 hour',
      '00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000010','draft',manager,'End-of-day fixture') returning id into ride;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
  payload:=jsonb_build_object('ride_id',ride,'legs',jsonb_build_array(jsonb_build_object('ride_id',ride,'leg','both','car_mode','passenger')),
    'ends_at',((w+1)+time '23:59') at time zone 'Asia/Jerusalem');
  proposal:=public.create_proposal(request_id,ride,'merge',payload,'End-of-day merge');
  assert (select (p.payload->>'ends_at')::timestamptz=((w+1)+time '23:59') at time zone 'Asia/Jerusalem' from public.proposals p where id=proposal),
    'valid end-of-day merge lost its agreed end';
  begin
    perform public.create_proposal(request_id,ride,'merge',payload||jsonb_build_object('ends_at',((w+2)+time '00:00') at time zone 'Asia/Jerusalem'),'Overnight merge');
    raise exception 'overnight combined proposal accepted';
  exception when raise_exception then if sqlerrm<>'ride_request_day_mismatch' then raise; end if; end;
  begin
    perform public.create_proposal(request_id,ride,'merge',payload||jsonb_build_object('ends_at',((w+1)+time '23:58') at time zone 'Asia/Jerusalem'),'Off-grid merge');
    raise exception 'off-grid combined proposal accepted';
  exception when raise_exception then if sqlerrm<>'ride_request_day_mismatch' then raise; end if; end;
end $$;
rollback;
