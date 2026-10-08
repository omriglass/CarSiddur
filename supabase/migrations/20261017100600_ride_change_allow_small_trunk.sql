-- REQ §13.111 (a): a member's ride change (new car) may carry the driver's `allow_small_trunk` for their own
-- large-luggage request(s). request_ride_change refuses with needs_large_trunk without it, stores it on the change
-- request, and the accepted change stamps the waiver when the car actually changes.

alter table public.ride_change_requests add column allow_small_trunk boolean not null default false;

drop function if exists public.request_ride_change(uuid, uuid, timestamp with time zone, timestamp with time zone, integer);
CREATE OR REPLACE FUNCTION public.request_ride_change(p_ride_id uuid, p_car_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_expected_version integer, p_allow_small_trunk boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare r public.rides%rowtype; other public.rides%rowtype; ch uuid; buffer interval; cnt int:=0;
begin
  select * into r from public.rides where id=p_ride_id for update;
  if not found then raise exception 'ride_not_found'; end if;
  if not public.is_approved() or r.driver_id is distinct from (select auth.uid()) or not public.is_week_public(r.department_id,r.week_start) then raise exception 'not_authorized'; end if;
  if r.status='cancelled' or r.version<>p_expected_version then perform public.raise_stale_version(); end if;
  if p_starts_at<=now() or p_ends_at<=p_starts_at or (p_starts_at at time zone 'Asia/Jerusalem')::date<>(r.starts_at at time zone 'Asia/Jerusalem')::date then raise exception 'ride_request_day_mismatch'; end if;
  if not (public.week_range(r.week_start) @> tstzrange(p_starts_at,p_ends_at,'[)')) then raise exception 'ride_outside_week'; end if;
  if exists(select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=r.id and (q.requester_id<>r.driver_id or rr.car_mode='relay')) then raise exception 'shared_ride_requires_sadran'; end if;
  -- REQ §13.111 (a): the driver may accept a car without a large trunk for their own large-luggage request(s); the
  -- waiver is stamped only when the change is accepted (respond_ride_change_before_planning).
  perform public._small_trunk_check(array(select rr.request_id from public.ride_requests rr where rr.ride_id=r.id), p_car_id, p_allow_small_trunk);
  perform 1 from public.cars where id=p_car_id and department_id=r.department_id and status='active' and type='shared' for update;
  if not found then raise exception 'car_unavailable'; end if;
  select make_interval(mins=>coalesce((w.settings_overrides->>'turnaround_minutes')::int,s.turnaround_minutes)) into buffer
  from public.department_settings s join public.weeks w on w.department_id=s.department_id where w.department_id=r.department_id and w.week_start=r.week_start;
  if exists(select 1 from public.car_maintenance_blocks where car_id=p_car_id and tstzrange(starts_at,ends_at,'[)') && tstzrange(p_starts_at,p_ends_at+buffer,'[)')) then raise exception 'ride_conflicts_with_maintenance'; end if;
  update public.ride_change_requests set status='cancelled' where ride_id=r.id and status='pending';
  insert into public.ride_change_requests(department_id,week_start,requester_id,ride_id,car_id,starts_at,ends_at,expected_version,allow_small_trunk)
  values(r.department_id,r.week_start,(select auth.uid()),r.id,p_car_id,p_starts_at,p_ends_at,r.version,coalesce(p_allow_small_trunk,false)) returning id into ch;
  for other in select * from public.rides where car_id=p_car_id and id<>r.id and status<>'cancelled'
    and tstzrange(starts_at,blocked_until,'[)') && tstzrange(p_starts_at,p_ends_at+buffer,'[)') order by id for update loop
    if other.driver_id is null or other.driver_id=r.driver_id or other.origin_id<>other.destination_id
      or exists(select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=other.id and q.requester_id<>other.driver_id)
    then raise exception 'shared_ride_requires_sadran'; end if;
    insert into public.ride_change_parties(change_id,ride_id,profile_id,expected_version) values(ch,other.id,other.driver_id,other.version);
    perform public.enqueue_notification(other.driver_id,'proposal_received',r.department_id,r.week_start,
      jsonb_build_object('requesterName',(select full_name from public.profiles where id=r.driver_id),
        'date',to_char(p_starts_at at time zone 'Asia/Jerusalem','DD/MM/YY'),
        'depart',to_char(p_starts_at at time zone 'Asia/Jerusalem','HH24:MI'),'return',to_char(p_ends_at at time zone 'Asia/Jerusalem','HH24:MI')),
      jsonb_build_object('ride_change_id',ch,'ride_id',other.id,'url','/inbox?change='||ch),format('ride_change:%s:%s',ch,other.driver_id));
    cnt:=cnt+1;
  end loop;
  if cnt=0 then raise exception 'no_conflicting_ride'; end if;
  return ch;
end $function$;

revoke all on function public.request_ride_change(uuid, uuid, timestamptz, timestamptz, integer, boolean) from public, anon;
grant execute on function public.request_ride_change(uuid, uuid, timestamptz, timestamptz, integer, boolean) to authenticated;

CREATE OR REPLACE FUNCTION public.respond_ride_change_before_planning(p_change_id uuid, p_accept boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare ch public.ride_change_requests%rowtype; r public.rides%rowtype; party record;
begin
  select * into ch from public.ride_change_requests where id=p_change_id for update;
  if not found then raise exception 'ride_change_not_found'; end if;
  if not public.is_approved() or not exists(select 1 from public.ride_change_parties where change_id=ch.id and profile_id=(select auth.uid())) then raise exception 'not_authorized'; end if;
  if ch.status<>'pending' then raise exception 'ride_change_not_pending'; end if;
  if ch.starts_at<=now() then update public.ride_change_requests set status='cancelled' where id=ch.id; return; end if;
  update public.ride_change_parties set accepted=p_accept,responded_at=now() where change_id=ch.id and profile_id=(select auth.uid());
  if not p_accept then update public.ride_change_requests set status='declined' where id=ch.id; return; end if;
  if exists(select 1 from public.ride_change_parties where change_id=ch.id and accepted is distinct from true) then return; end if;
  perform 1 from public.rides where id=ch.ride_id or id in(select ride_id from public.ride_change_parties where change_id=ch.id) order by id for update;
  select * into r from public.rides where id=ch.ride_id;
  if r.version<>ch.expected_version or r.status='cancelled' or exists(
    select 1 from public.ride_change_parties p join public.rides rd on rd.id=p.ride_id where p.change_id=ch.id and (rd.version<>p.expected_version or rd.status='cancelled')
  ) then update public.ride_change_requests set status='cancelled' where id=ch.id; return; end if;
  perform set_config('app.audit_reason','accepted_ride_change',true);
  if ch.allow_small_trunk then perform public._small_trunk_mode(true); end if;   -- REQ §13.111 (a): the proposer's waiver
  perform set_config('app.system_status_transition','on',true);
  for party in select * from public.ride_change_parties where change_id=ch.id loop
    update public.rides set status='cancelled',cancelled_at=now(),cancelled_by=party.profile_id,cancel_reason='ACCEPTED_RIDE_CHANGE' where id=party.ride_id;
    update public.requests set status='cancelled',status_reason='RIDE_CANCELLED' where id in(select request_id from public.ride_requests where ride_id=party.ride_id);
    delete from public.ride_requests where ride_id=party.ride_id;
  end loop;
  update public.rides set car_id=ch.car_id,starts_at=ch.starts_at,ends_at=ch.ends_at,is_pinned=true,pin_reason='MEMBER_EDIT' where id=ch.ride_id;
  perform public.assert_ride_request_day(ch.ride_id);
  perform public.assert_ride_seats_fit(ch.ride_id);
  perform public.assert_car_chain(ch.car_id,ch.week_start);
  if r.car_id<>ch.car_id then perform public.assert_car_chain(r.car_id,ch.week_start); end if;
  update public.ride_change_requests set status='accepted' where id=ch.id;
  perform set_config('app.system_status_transition','off',true);
end $function$;
