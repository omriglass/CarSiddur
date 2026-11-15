-- QA run 20 fixes (owner 2026-11-14; docs/TODO.md "QA run 20 findings"):
-- R20B1 split_series keeps the car across the cut with no turnaround (the earlier ride carries the real gap as its
--        turnaround override); publication_conflict_details reports a ride whose turnaround the next ride cuts into
--        ('turnaround'), so readiness counts it and publishing names the rides instead of failing in the ride trigger.
-- R20B3 split_series notifies only when one of the series' days is published.
-- R20B4 the co-owner's private_car_changed notice is held on the board like the rider's (_board_hold_applies).
-- R20B2 leave_merged_ride tells the driver someone else removed (variants removed_as_driver / _handed) and records
--        SADRAN_REMOVED_DRIVER instead of WITHDRAWN_BY_MEMBER. Q5: no rider takes the wheel of a הקפצה.
-- R20B7 publish_siddur: a pending proposal blocks the day, not bypassable ('publication_proposals_pending');
--        agree_proposals_offline marks every pending proposal of the chosen days agreed (owner: "mark all as accepted").

CREATE OR REPLACE FUNCTION public.split_series(p_request_id uuid, p_cut_after integer[], p_expected_version integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  q public.requests%rowtype;
  v_actor uuid := (select auth.uid());
  v_prev_flag text := coalesce(current_setting('app.system_status_transition', true), '');
  v_applying text := coalesce(nullif(current_setting('app.applying_proposal', true), ''), '');
  v_old uuid; v_n int; v_cuts int[]; v_bounds int[]; v_p int; v_from int; v_to int; v_len int; v_sid uuid;
  v_parts jsonb := '[]'::jsonb; v_ids uuid[]; v_head uuid; v_prop uuid; v_parts_text text; v_route text; v_name text;
  x record; v_notif uuid; v_rides uuid[]; v_public boolean;
begin
  select * into q from public.requests where id = p_request_id;
  if q.id is null or q.series_id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  v_old := q.series_id;
  -- REQ §13.127: whoever may edit the request (requester, filer, related), or the Sadran of every week it touches
  if not (q.requester_id = v_actor or public.request_related(p_request_id, v_actor)
          or not exists (select 1 from public.requests y where y.series_id = v_old
                           and not public.can_manage_week(y.department_id, y.week_start))) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if p_expected_version is not null and q.version <> p_expected_version then
    raise exception 'stale_version' using errcode = 'P0409';
  end if;
  if exists (select 1 from public.requests y join public.weeks w on w.department_id = y.department_id and w.week_start = y.week_start
             where y.series_id = v_old and w.phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  -- (c) another member's request on one of the series' rides is not ours to split away
  if exists (select 1 from public.rides r join public.ride_requests rr on rr.ride_id = r.id join public.requests y on y.id = rr.request_id
             where r.series_id = v_old and r.status <> 'cancelled' and y.series_id is distinct from v_old) then
    raise exception 'series_span_shared_ride' using errcode = 'P0001';
  end if;

  perform 1 from public.requests where series_id = v_old order by id for update;
  create temporary table if not exists pg_temp._split_days (i int primary key, request_id uuid, d date) on commit drop;
  delete from pg_temp._split_days where true;   -- the API guard refuses a DELETE with no WHERE
  insert into pg_temp._split_days (i, request_id, d)
  select row_number() over (order by y.depart_at, y.id)::int, y.id, (y.depart_at at time zone 'Asia/Jerusalem')::date
  from public.requests y where y.series_id = v_old and y.status not in ('withdrawn', 'cancelled');
  select count(*) into v_n from pg_temp._split_days;
  select coalesce(array_agg(distinct c order by c), '{}') into v_cuts from unnest(coalesce(p_cut_after, '{}')) c;
  if v_n < 2 or cardinality(v_cuts) = 0 or v_cuts[1] < 1 or v_cuts[cardinality(v_cuts)] > v_n - 1 then
    raise exception 'series_split_invalid' using errcode = 'P0001';
  end if;

  perform set_config('app.system_status_transition', 'on', true);
  perform set_config('app.audit_reason', 'split_series', true);
  -- (d) nothing stays open on the series (as for shortening)
  for v_prop in select p.id from public.proposals p
      where p.request_id in (select s.request_id from pg_temp._split_days s)
        and p.status in ('draft', 'sent', 'accepted') and p.id::text <> v_applying order by p.id loop
    if exists (select 1 from public.proposals where id = v_prop and status = 'draft') then
      update public.proposals set status = 'withdrawn' where id = v_prop;
    else
      perform public.proposal_system_withdraw(v_prop, 'withdrawn_edit');
    end if;
  end loop;

  v_rides := array(select r.id from public.rides r where r.series_id = v_old and r.status <> 'cancelled');
  v_bounds := array[0] || v_cuts || array[v_n];
  for v_p in 1 .. cardinality(v_bounds) - 1 loop
    v_from := v_bounds[v_p] + 1; v_to := v_bounds[v_p + 1]; v_len := v_to - v_from + 1;
    v_sid := case when v_len = 1 then null when v_p = 1 then v_old else gen_random_uuid() end;
    select array_agg(s.request_id order by s.i) into v_ids from pg_temp._split_days s where s.i between v_from and v_to;
    update public.requests y set series_id = v_sid,
        series_index = case when v_sid is null then null else s.i - v_from + 1 end,
        series_count = case when v_sid is null then null else v_len end
      from pg_temp._split_days s where s.request_id = y.id and s.i between v_from and v_to;
    update public.rides r set series_id = v_sid
      where r.series_id = v_old and r.status <> 'cancelled'
        and exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and rr.request_id = any(v_ids));
    v_parts := v_parts || jsonb_build_array(jsonb_build_object('series_id', v_sid, 'request_ids', to_jsonb(v_ids),
      'first', (select d from pg_temp._split_days where i = v_from), 'last', (select d from pg_temp._split_days where i = v_to)));
  end loop;
  -- R20B1 (owner 2026-11-14): the parts keep the car across the cut with no turnaround, as the series did (Mon ends
  -- 23:59, Tue starts 00:00). The earlier ride carries the real gap as its turnaround override, which every check
  -- (the ride trigger, publication, the solver, the board) already honours; refresh_car_turnarounds keeps it.
  update public.rides a set turnaround_override_minutes = (extract(epoch from (b.starts_at - a.ends_at)) / 60)::smallint
    from public.rides b
   where a.id = any(v_rides) and b.id = any(v_rides) and b.car_id = a.car_id and b.id <> a.id
     and not (a.series_id is not null and a.series_id = b.series_id)
     and b.starts_at >= a.ends_at
     and b.starts_at < a.ends_at + make_interval(mins => public.required_turnaround_minutes(a.department_id, a.week_start));
  -- cancelled rides of days that left the series follow their own day's part (or none)
  update public.rides r set series_id = null where r.series_id = v_old and r.status = 'cancelled'
    and not exists (select 1 from public.requests y where y.series_id = v_old
                    and (y.depart_at at time zone 'Asia/Jerusalem')::date = (r.starts_at at time zone 'Asia/Jerusalem')::date);
  perform set_config('app.system_status_transition', v_prev_flag, true);

  -- (d) one notice per person on the ride other than the actor - only when one of its days is published (R20B3:
  -- before that nobody sees the series, as for every other unpublished change)
  v_public := exists (select 1 from pg_temp._split_days s join public.requests y on y.id = s.request_id
                      where public.is_day_public(y.department_id, y.week_start, s.d));
  if not v_public then return jsonb_build_object('parts', v_parts); end if;
  select string_agg(case when (pt ->> 'first') = (pt ->> 'last') then public.day_date_label((pt ->> 'first')::date)
                         else public.day_date_label((pt ->> 'first')::date) || '–' || public.day_date_label((pt ->> 'last')::date) end,
                    ', ' order by ord)
    into v_parts_text from jsonb_array_elements(v_parts) with ordinality t(pt, ord);
  v_head := (v_parts -> 0 -> 'request_ids' ->> 0)::uuid;
  v_route := public.request_route_label(v_head);
  select full_name into v_name from public.profiles where id = v_actor;
  for x in
    select distinct pid from (
      select q2.requester_id as pid from public.requests q2 where q2.id in (select s.request_id from pg_temp._split_days s)
      union select rc.profile_id from public.request_companions rc where rc.request_id in (select s.request_id from pg_temp._split_days s)
      union select q2.filed_by from public.requests q2 where q2.id in (select s.request_id from pg_temp._split_days s)
      union select rp.person_id from public.ride_passengers rp join public.ride_requests rr on rr.ride_id = rp.ride_id
            where rr.request_id in (select s.request_id from pg_temp._split_days s)
      union select r.driver_id from public.rides r join public.ride_requests rr on rr.ride_id = r.id
            where rr.request_id in (select s.request_id from pg_temp._split_days s) and r.status <> 'cancelled'
    ) people where pid is not null and pid is distinct from v_actor
  loop
    v_notif := public.enqueue_notification(x.pid, 'ride_edited', q.department_id, q.week_start,
      jsonb_build_object('byName', coalesce(v_name, ''), 'route', coalesce(v_route, ''), 'parts', coalesce(v_parts_text, '')),
      jsonb_build_object('variant', 'series_split', 'request_id', v_head),
      format('series_split:%s:%s:%s', v_old, x.pid, clock_timestamp()));
    if v_notif is not null and not coalesce((select p.push_on_ride_edits from public.profiles p where p.id = x.pid), true) then
      delete from public.push_outbox where notification_id = v_notif;   -- REQ §13.169 (e): the push follows the profile switch
    end if;
  end loop;
  return jsonb_build_object('parts', v_parts);
end $function$;

CREATE OR REPLACE FUNCTION public.publication_conflict_details(p_department_id uuid, p_week_start date, p_days date[])
 RETURNS TABLE(ride_id uuid, reason text, other_ride_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare r record; here uuid; res boolean; o uuid; nxt uuid; v_tight uuid;
begin
  for r in
    select * from public.rides where department_id=p_department_id and week_start=p_week_start and status<>'cancelled'
      and (starts_at at time zone 'Asia/Jerusalem')::date=any(p_days)
  loop
    res:=public.ride_is_reservation(r.id);
    ride_id:=r.id; other_ride_id:=null;
    if r.starts_at>=r.ends_at or (r.starts_at at time zone 'Asia/Jerusalem')::date<>(r.ends_at at time zone 'Asia/Jerusalem')::date
      or (r.ends_at at time zone 'Asia/Jerusalem')::time>'23:59'::time
      or (r.starts_at at time zone 'Asia/Jerusalem')::date not between p_week_start and p_week_start+6 then
      reason:='bad_window'; other_ride_id:=null; return next;
    end if;
    select other.id into o from public.rides other where other.id<>r.id and other.status<>'cancelled' and not other.draft_hold and not r.draft_hold and other.car_id=r.car_id
      and tstzrange(other.starts_at,other.ends_at,'[)') && tstzrange(r.starts_at,r.ends_at,'[)') order by other.starts_at limit 1;
    if o is not null then reason:='car_overlap'; other_ride_id:=o; return next; end if;
    other_ride_id:=null;
    -- R20B1: the next ride on the car starts inside this ride's turnaround (the ride trigger refuses it on publish);
    -- consecutive days of one series need none, and an approved shorter turnaround is in blocked_until already.
    if o is null and not r.draft_hold then
      select nx.id into v_tight from public.rides nx
       where nx.id<>r.id and nx.car_id=r.car_id and nx.status<>'cancelled' and not nx.draft_hold and not nx.planning_conflict
         and not r.planning_conflict and nx.starts_at>=r.ends_at and nx.starts_at<r.blocked_until
         and not (r.series_id is not null and nx.series_id=r.series_id)
       order by nx.starts_at, nx.id limit 1;
      if v_tight is not null then reason:='turnaround'; other_ride_id:=v_tight; return next; other_ride_id:=null; end if;
    end if;
    if exists(select 1 from public.car_maintenance_blocks b where b.car_id=r.car_id
      and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(r.starts_at,r.ends_at,'[)')) then reason:='maintenance'; return next; end if;
    if not exists(select 1 from public.cars c where c.id=r.car_id and c.department_id=p_department_id and c.status='active') then
      reason:='car_unavailable'; return next;
    end if;
    if not res then
      select prev.id, prev.destination_id into o, here from public.rides prev
        where prev.car_id=r.car_id and prev.status<>'cancelled' and (prev.starts_at,prev.id)<(r.starts_at,r.id)
          and not public.ride_is_reservation(prev.id)
        order by prev.starts_at desc,prev.id desc limit 1;
      if o is null then here:=public.car_base_location(r.car_id); end if;
      if r.origin_id is distinct from here then reason:='car_not_at_origin'; other_ride_id:=o; return next; end if;
      other_ride_id:=null;
      select nx.id into nxt from public.rides nx
        where nx.car_id=r.car_id and nx.week_start=p_week_start and nx.status<>'cancelled' and (nx.starts_at,nx.id)>(r.starts_at,r.id)
          and not public.ride_is_reservation(nx.id)
        order by nx.starts_at,nx.id limit 1;
      if nxt is not null and exists(select 1 from public.rides f where f.id=nxt and f.origin_id is distinct from r.destination_id) then
        reason:='next_ride_not_here'; other_ride_id:=nxt; return next; other_ride_id:=null;
      end if;
    end if;
    begin perform public.assert_ride_request_day(r.id);
    exception when raise_exception or check_violation then reason:='request_day'; return next; end;
    begin perform public.assert_ride_driver(r.id);
    exception when raise_exception or check_violation then reason:='driver'; return next; end;
    begin perform public.assert_ride_seats_fit(r.id);
    exception when raise_exception or check_violation then reason:='seats'; return next; end;
  end loop;
  -- pending provisional (planning) edits on a live ride block too; a cancelled ride's shadow is not a ride to show.
  return query select distinct c.ride_id, 'planning_edit'::text, null::uuid from public.ride_change_requests c
    join public.rides rr on rr.id=c.ride_id and rr.status<>'cancelled'
    where c.department_id=p_department_id and c.week_start=p_week_start and c.status='pending'
      and coalesce((to_jsonb(c)->>'is_planning')::boolean,false)
      and (c.starts_at at time zone 'Asia/Jerusalem')::date=any(p_days);
end;
$function$;

CREATE OR REPLACE FUNCTION public._board_hold_applies(_recipient uuid, _event notification_event, _department_id uuid, _week_start date)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_headers text := nullif(current_setting('request.headers', true), '');
  v_actor uuid := (select auth.uid());
  v_surface text;
begin
  if v_headers is null or v_actor is null or _recipient is null or _department_id is null or _week_start is null then
    return false;
  end if;
  if coalesce(current_setting('app.flushing_held_notices', true), '') = 'on'
     or coalesce(current_setting('app.publishing', true), '') = 'on'
     or coalesce(current_setting('app.notify_now', true), '') = 'on' then   -- R15M2: a live-week cancellation
    return false;
  end if;
  if _event not in ('outcome_changed', 'car_swapped', 'waitlist_resolved', 'private_car_changed') or _recipient = v_actor then
    return false;
  end if;
  begin
    v_surface := v_headers::json ->> 'x-app-surface';
  exception when others then
    return false;
  end;
  if v_surface is distinct from 'board' or not public.can_manage_week(_department_id, _week_start) then
    return false;
  end if;
  return not exists (select 1 from public.sadranim_of(_department_id, _week_start) s where s = _recipient);
end $function$;

CREATE OR REPLACE FUNCTION public._notify_private_car_owners(p_ride uuid, p_car uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_car record; v_ride record; v_day date; v_actor_name text;
  o record; v_old record; v_names jsonb; v_old_ids uuid[]; v_notif uuid; v_held boolean;
begin
  if v_actor is null or p_car is null or p_ride is null then return; end if;
  if coalesce(current_setting('app.publishing', true), '') = 'on' then return; end if;
  select c.id, c.name, c.type into v_car from public.cars c where c.id = p_car;
  if v_car.type is distinct from 'temporary' then return; end if;
  select r.id, r.starts_at, r.department_id, r.week_start into v_ride from public.rides r where r.id = p_ride;
  if v_ride.id is null then return; end if;
  v_day := (v_ride.starts_at at time zone 'Asia/Jerusalem')::date;
  if not public.is_day_public(v_ride.department_id, v_ride.week_start, v_day) then return; end if;
  select full_name into v_actor_name from public.profiles where id = v_actor;

  for o in
    select co.profile_id from public.car_owners co
    where co.car_id = p_car and co.profile_id <> v_actor
      and co.profile_id not in (select x.pid from public._ride_person_ids(p_ride) x where x.pid is not null)
    order by co.profile_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(format('private_car_changed:%s:%s:%s', p_car, v_day, o.profile_id), 0));
    v_names := '[]'::jsonb; v_old_ids := null;
    -- R20B4: on the board the notice is held with the rider's (REQ §13.138 c) - it then neither merges into nor
    -- replaces the one already delivered; "שלח" sends it.
    v_held := public._board_hold_applies(o.profile_id, 'private_car_changed', v_ride.department_id, v_ride.week_start);
    for v_old in
      select n.id, n.data from public.notifications n
      where not v_held and n.recipient_id = o.profile_id and n.event = 'private_car_changed' and n.read_at is null
        and n.data ->> 'car_id' = p_car::text and n.data ->> 'day' = v_day::text
      order by n.created_at, n.id
    loop
      v_old_ids := array_append(v_old_ids, v_old.id);
      v_names := v_names || coalesce(v_old.data -> 'names', '[]'::jsonb);
    end loop;
    v_names := v_names || to_jsonb(array[coalesce(v_actor_name, '')]);
    select coalesce(jsonb_agg(nm order by ord), '[]'::jsonb) into v_names
    from (select nm, min(ord) as ord from jsonb_array_elements_text(v_names) with ordinality u(nm, ord)
          where nm <> '' group by nm) x;
    if v_old_ids is not null then delete from public.notifications where id = any(v_old_ids); end if;
    v_notif := public.enqueue_notification(o.profile_id, 'private_car_changed', v_ride.department_id, v_ride.week_start,
      jsonb_build_object('carName', v_car.name, 'day', public.day_date_label(v_ride.starts_at),
        'byName', public._and_list(array(select jsonb_array_elements_text(v_names)))),
      jsonb_build_object('car_id', p_car, 'ride_id', p_ride, 'day', v_day, 'names', v_names),
      format('private_car_changed:%s:%s:%s:%s', p_car, v_day, o.profile_id, clock_timestamp()));
    -- the unread notice it replaces already pushed: this one stays quiet
    if v_notif is not null and v_old_ids is not null then
      delete from public.push_outbox where notification_id = v_notif;
    end if;
  end loop;
end $function$;

CREATE OR REPLACE FUNCTION public.leave_merged_ride(p_ride_id uuid, p_expected_version integer, p_new_driver uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  r public.rides%rowtype;
  v_actor uuid := (select auth.uid());
  v_leaver uuid;
  v_prev_flag text := coalesce(current_setting('app.system_status_transition', true), '');
  v_mine uuid[];            -- the leaver's requests on the ride
  v_x_request uuid;         -- the request X drives on (X's own, or the one X is a companion on); null = an added passenger
  v_x_companion_of_mine boolean := false;
  v_by text; v_driver_name text; v_route text; v_day text; v_car text; v_range text; p record; v_actor_name text;
begin
  if not public.is_approved() then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  select * into r from public.rides where id = p_ride_id for update;
  if not found or r.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if p_expected_version is null or r.version <> p_expected_version then perform public.raise_stale_version(); end if;
  v_leaver := r.driver_id;
  if v_leaver is null or not (v_leaver = v_actor or public.can_manage_week(r.department_id, r.week_start)) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.weeks w where w.department_id = r.department_id and w.week_start = r.week_start and w.phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  if (r.starts_at at time zone 'Asia/Jerusalem')::date < (now() at time zone 'Asia/Jerusalem')::date then
    raise exception 'ride_in_past' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(distinct rr.request_id), '{}') into v_mine
  from public.ride_requests rr join public.requests q on q.id = rr.request_id
  where rr.ride_id = r.id and q.requester_id = v_leaver;
  -- a merge: the ride also serves someone else's request; not a multi-day ride; the leaver's trip is held only here
  if r.series_id is not null
     or not exists (select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
                    where rr.ride_id = r.id and q.requester_id is distinct from v_leaver)
     or exists (select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
                where rr.ride_id = r.id and q.series_id is not null)
     or exists (select 1 from public.ride_requests rr2 join public.rides o on o.id = rr2.ride_id
                where rr2.request_id = any(v_mine) and rr2.ride_id <> r.id and o.status <> 'cancelled') then
    raise exception 'handover_not_possible' using errcode = 'P0001';
  end if;

  if p_new_driver is not null then
    if p_new_driver = v_leaver
       or not exists (select 1 from public.profiles pr where pr.id = p_new_driver and pr.approval_status = 'approved' and not pr.does_not_drive)
       or not exists (select 1 from public.department_members dm where dm.department_id = r.department_id and dm.profile_id = p_new_driver and dm.removed_at is null)
       -- Q5 (owner 2026-11-14): never a rider at the wheel of a הקפצה - the rider is the one being driven
       or exists (select 1 from public.ride_requests rr join public.requests q on q.id = rr.request_id
                  where rr.ride_id = r.id and q.trip_type = 'drop_off') then
      raise exception 'handover_driver_invalid' using errcode = 'P0001';
    end if;
    v_x_companion_of_mine := exists (select 1 from public.request_companions rc where rc.request_id = any(v_mine) and rc.profile_id = p_new_driver);
    if v_x_companion_of_mine then
      v_x_request := (select rc.request_id from public.request_companions rc where rc.request_id = any(v_mine) and rc.profile_id = p_new_driver
                      order by rc.request_id limit 1);
    else
      -- X's own request on the ride, or one X is a companion on — both ways
      select rr.request_id into v_x_request
      from public.ride_requests rr join public.requests q on q.id = rr.request_id
      where rr.ride_id = r.id and rr.leg = 'both' and not (rr.request_id = any(v_mine))
        and (q.requester_id = p_new_driver
             or exists (select 1 from public.request_companions rc where rc.request_id = q.id and rc.profile_id = p_new_driver))
      order by (q.requester_id = p_new_driver) desc, rr.request_id limit 1;
      if v_x_request is null and not exists (
           select 1 from public.ride_passengers rp where rp.ride_id = r.id and rp.person_id = p_new_driver and rp.leg = 'both') then
        raise exception 'handover_driver_invalid' using errcode = 'P0001';
      end if;
    end if;
  end if;
  -- the leaver's request takes other people with it: only their companion may take it over
  if not v_x_companion_of_mine and exists (
       select 1 from public.request_companions rc where rc.request_id = any(v_mine)
       union all select 1 from public.request_children ch where ch.request_id = any(v_mine)) then
    raise exception 'handover_not_possible' using errcode = 'P0001', detail = 'leaver_has_companions';
  end if;

  perform set_config('app.audit_reason', 'leave_merged_ride', true);
  if v_x_companion_of_mine then
    -- X takes the leaver's trip over (§13.129 b)
    for p in select unnest(v_mine) as id loop
      delete from public.request_companions where request_id = p.id and profile_id = p_new_driver;
      update public.requests set requester_id = p_new_driver, adults = greatest(adults - 1, 1) where id = p.id;
    end loop;
    update public.rides set driver_id = p_new_driver where id = r.id;
  else
    delete from public.ride_requests where ride_id = r.id and request_id = any(v_mine);
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'withdrawn',
      status_reason = case when v_actor = v_leaver then 'WITHDRAWN_BY_MEMBER' else 'SADRAN_REMOVED_DRIVER' end   -- R20B2
      where id = any(v_mine);
    perform set_config('app.system_status_transition', v_prev_flag, true);
    if p_new_driver is null then
      update public.rides set driver_id = null, needs_driver = true where id = r.id;
    else
      -- X's own trip stays a passenger trip on the ride (it boards where it boards); the ride just has X at the wheel
      -- (assert_ride_driver allows a driver with no 'driver' row). An added passenger stops being a passenger row.
      if v_x_request is null then
        delete from public.ride_passengers where ride_id = r.id and person_id = p_new_driver;
      end if;
      update public.rides set driver_id = p_new_driver where id = r.id;
    end if;
  end if;
  perform public.assert_ride_driver(r.id);
  perform public.assert_ride_seats_fit(r.id);

  -- R20B2: the driver someone else took off is always told, published day or not - their own request ended
  if v_actor <> v_leaver then
    select full_name into v_actor_name from public.profiles where id = v_actor;
    perform public.enqueue_notification(v_leaver, 'outcome_changed', r.department_id, r.week_start,
      jsonb_build_object('byName', coalesce(v_actor_name, ''), 'day', public.day_date_label(r.starts_at),
        'driverName', coalesce((select full_name from public.profiles where id = p_new_driver), '')),
      jsonb_build_object('variant', case when v_x_companion_of_mine then 'removed_as_driver_handed' else 'removed_as_driver' end,
        'ride_id', r.id, 'request_id', v_mine[1]),
      format('removed_as_driver:%s:%s:%s', r.id, r.version, v_leaver));
  end if;
  if public.is_day_public(r.department_id, r.week_start, (r.starts_at at time zone 'Asia/Jerusalem')::date) then
    select full_name into v_by from public.profiles where id = v_leaver;
    select name into v_car from public.cars where id = r.car_id;
    v_route := coalesce(public.request_route_label((select rr.request_id from public.ride_requests rr where rr.ride_id = r.id
                                                    order by (rr.role = 'driver') desc, rr.request_id limit 1)), '');
    v_day := public.day_date_label(r.starts_at);
    v_range := to_char(r.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI') || '–' || to_char(r.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI');
    if p_new_driver is not null then
      select full_name into v_driver_name from public.profiles where id = p_new_driver;
      if p_new_driver <> v_actor then
        perform public.enqueue_notification(p_new_driver, 'outcome_changed', r.department_id, r.week_start,
          jsonb_build_object('byName', coalesce(v_by, ''), 'route', v_route, 'day', v_day,
            'depart', to_char(r.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI'), 'return', to_char(r.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI'),
            'car', coalesce(v_car, '')),
          jsonb_build_object('variant', 'driver_assigned', 'ride_id', r.id),
          format('driver_assigned:%s:%s:%s', r.id, r.version, p_new_driver));
      end if;
    end if;
    for p in
      select x.pid from public._ride_person_ids(r.id) x
      where x.pid is not null and x.pid <> v_actor and x.pid <> v_leaver and x.pid is distinct from p_new_driver
    loop
      perform public.enqueue_notification(p.pid, 'outcome_changed', r.department_id, r.week_start,
        jsonb_build_object('driverName', coalesce(case when p_new_driver is null then v_by else v_driver_name end, ''),
          'route', v_route, 'day', v_day, 'car', coalesce(v_car, ''), 'timeRange', v_range),
        jsonb_build_object('variant', case when p_new_driver is null then 'driver_cancelled_plain' else 'driver_changed_passenger' end, 'ride_id', r.id),
        format('leave_merged_ride:%s:%s:%s', r.id, r.version, p.pid));
    end loop;
  end if;
  return jsonb_build_object('ride_id', r.id, 'driver_id', p_new_driver, 'withdrawn', case when v_x_companion_of_mine then '[]'::jsonb else to_jsonb(v_mine) end);
end $function$;

CREATE OR REPLACE FUNCTION public.publish_siddur(p_department_id uuid, p_week_start date, p_profile_scores jsonb DEFAULT '[]'::jsonb, p_expected_fingerprint text DEFAULT NULL::text, p_policy_scores jsonb DEFAULT '[]'::jsonb, p_days date[] DEFAULT NULL::date[], p_allow_unanswered boolean DEFAULT false, p_allow_driverless boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_snapshot jsonb;
  v_days date[]; v_prior_days date[]; v_public_days date[]; readiness jsonb;
  v_day date;
  v_version_id uuid := gen_random_uuid();
  v_prev record;
  v_phase public.week_phase;
  v_req record;
  v_notified int := 0;
  v_items jsonb; v_dates date[]; v_extra text; v_old_ids uuid[]; v_old record; v_notif uuid; v_lines text; v_days_txt text;
  v_prev_publishing text := coalesce(current_setting('app.publishing', true), '');
  v_prev_status text;
  v_event public.notification_event;
  policy_score jsonb;
  n int; served_n int; total numeric; served_total numeric;
begin
  -- REQ §13.138 (c): publishing's own notices are never held as board changes.
  perform set_config('app.publishing', 'on', true);
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  perform 1 from public.weeks where department_id=p_department_id and week_start=p_week_start for update;
  if not found then raise exception 'week_not_open'; end if;
  if exists(select 1 from public.weeks where department_id=p_department_id and week_start=p_week_start and phase='archived') then raise exception 'week_archived'; end if;
  if exists(select 1 from public.weeks where department_id=p_department_id and week_start=p_week_start and phase='upcoming') then raise exception 'week_not_open'; end if;
  -- Lock publication inputs while the snapshot and scores are checked and saved.
  lock table public.requests,public.rides,public.ride_requests,public.policies,public.department_settings,public.cars,public.car_seat_configs,public.car_maintenance_blocks,public.destinations,public.proposals,public.proposal_parties,public.ride_change_requests,public.ride_change_parties in share mode;
  if p_expected_fingerprint is not null and p_expected_fingerprint<>public.publish_scores_fingerprint(p_department_id,p_week_start) then
    raise exception 'stale_input' using errcode='P0409';
  end if;
  select array_agg(distinct d order by d) into v_days from unnest(coalesce(p_days,array(select p_week_start+i from generate_series(0,6) i))) d;
  if coalesce(cardinality(v_days),0)=0 or exists(select 1 from unnest(v_days) d where d is null or d<p_week_start or d>p_week_start+6) then
    raise exception 'invalid_publication_days';
  end if;
  select published_days into v_prior_days from public.weeks where department_id=p_department_id and week_start=p_week_start;
  select array_agg(distinct d order by d) into v_public_days from unnest(v_prior_days||v_days) d;
  if exists(select 1 from public.publication_conflicting_ride_ids(p_department_id,p_week_start,v_days)) then raise exception 'publication_conflicts';end if;
  readiness:=public.publication_readiness(p_department_id,p_week_start);
  -- 20260910091800: `unresolvedRequests` is informational now. A still-unresolved
  -- round-trip request no longer blocks publication — form_waitlist_groups() below either
  -- auto-approves it onto a free car or puts it into a contested group (REQ §7.3,
  -- consistency decision 25). What still blocks is a *defective* board: a request that IS
  -- assigned/merged but whose legs are not fully covered (`incompleteAssignments`), a
  -- pending proposal/ride change, or a ride with no driver.
  -- 20261005110300 (REQ §13.94): unsent draft proposals on a selected day always block, and
  -- `p_allow_unanswered` does not bypass it — a draft is the Sadran's own unfinished work.
  if exists(select 1 from jsonb_array_elements(readiness) item
    where (item->>'day')::date=any(v_days) and (item->>'alternativeProposals')::int>0)
  then raise exception 'publication_alternatives_pending';end if;
  if exists(select 1 from jsonb_array_elements(readiness) item
    where (item->>'day')::date=any(v_days) and (item->>'draftProposals')::int>0)
  then raise exception 'publication_drafts';end if;
  -- REQ §13.138 (g): board changes not yet told block the day, not bypassable either.
  if exists(select 1 from jsonb_array_elements(readiness) item
    where (item->>'day')::date=any(v_days) and coalesce((item->>'heldNotices')::int,0)>0)
  then raise exception 'publication_held_notices';end if;
  -- R20B7 (owner 2026-11-14): a pending proposal blocks the day, not bypassable - a late "yes" must never change a
  -- published ride behind the Sadran's back. Answer it, withdraw it, or mark it agreed (agree_proposals_offline).
  if exists(select 1 from jsonb_array_elements(readiness) item
    where (item->>'day')::date=any(v_days) and (item->>'pendingProposals')::int>0)
  then raise exception 'publication_proposals_pending';end if;
  if not coalesce(p_allow_unanswered,false) and exists(select 1 from jsonb_array_elements(readiness) item
    where (item->>'day')::date=any(v_days) and (item->>'incompleteAssignments')::int>0)
  then raise exception 'publication_unanswered';end if;
  -- R12M3 (REQ §13.119): rides still without a driver are not "unanswered"; the UI asks "publish anyway?" and sends
  -- p_allow_driverless (the older p_allow_unanswered keeps meaning "publish despite everything open", driverless included).
  if not coalesce(p_allow_driverless,false) and not coalesce(p_allow_unanswered,false) and exists(select 1 from jsonb_array_elements(readiness) item
    where (item->>'day')::date=any(v_days) and (item->>'missingDriverRides')::int>0)
  then raise exception 'publication_driverless';end if;
  if jsonb_typeof(p_profile_scores) is distinct from 'array' or jsonb_typeof(p_policy_scores) is distinct from 'array' then
    raise exception 'invalid_publication_scores';
  end if;
  if p_expected_fingerprint is null then
    raise exception 'stale_input' using errcode='P0409';
  end if;
  -- A missing or unavailable score calculation must never prevent publication — scores are
  -- a reporting snapshot and can be recomputed later. But score data that IS supplied must
  -- still be complete (one entry per scoreable request, no orphan entries) and internally
  -- consistent (per-policy sums match); wrong/partial data would otherwise corrupt the
  -- fairness history permanently.
  if jsonb_array_length(p_profile_scores) > 0 then
    if exists(select 1 from jsonb_array_elements(p_profile_scores) score where not exists (
        select 1 from public.requests q where q.requester_id=(score->>'profile_id')::uuid and q.department_id=p_department_id and q.week_start=p_week_start
      )) or exists (
        select 1 from public.requests q where q.department_id=p_department_id and q.week_start=p_week_start and q.status not in ('draft','withdrawn','cancelled')
          and (select count(*) from jsonb_array_elements(p_profile_scores) score cross join lateral jsonb_array_elements(score->'requests') item
               where (score->>'profile_id')::uuid=q.requester_id and (item->>'request_id')::uuid=q.id and jsonb_typeof(item->'score')='number')<>1
      ) or exists (
        select 1 from jsonb_array_elements(p_profile_scores) score cross join lateral jsonb_array_elements(score->'requests') item
        where not exists(select 1 from public.requests q where q.id=(item->>'request_id')::uuid and q.requester_id=(score->>'profile_id')::uuid
          and q.department_id=p_department_id and q.week_start=p_week_start and q.status not in ('draft','withdrawn','cancelled'))
      ) then raise exception 'invalid_publication_scores'; end if;
    perform public.assert_publication_scores(p_department_id,p_week_start,p_profile_scores);
  end if;
  if jsonb_array_length(p_policy_scores) > 0 then
    if (select count(distinct x->>'policy_id') from jsonb_array_elements(p_policy_scores) x)<>jsonb_array_length(p_policy_scores) then raise exception 'invalid_publication_scores'; end if;
    if exists(select 1 from public.policies p where (department_id=p_department_id or department_id is null) and current_version_id is not null
      and not exists(select 1 from jsonb_array_elements(p_policy_scores) x where (x->>'policy_id')::uuid=p.id and (x->>'policy_version_id')::uuid=p.current_version_id)
    ) then raise exception 'invalid_publication_scores'; end if;
    for policy_score in select * from jsonb_array_elements(p_policy_scores) loop
      if not exists(select 1 from public.policies p where p.id=(policy_score->>'policy_id')::uuid and p.current_version_id=(policy_score->>'policy_version_id')::uuid
        and (p.department_id=p_department_id or p.department_id is null)) then raise exception 'invalid_publication_scores'; end if;
      perform public.assert_publication_scores(p_department_id,p_week_start,policy_score->'profiles');
      select coalesce(sum((x->>'request_count')::int),0),coalesce(sum((x->>'served_count')::int),0),
        coalesce(sum((x->>'priority_total')::numeric),0),coalesce(sum((x->>'served_priority_total')::numeric),0)
        into n,served_n,total,served_total from jsonb_array_elements(policy_score->'profiles') x;
      if (policy_score->>'request_count')::int is distinct from n or (policy_score->>'served_count')::int is distinct from served_n
        or abs(coalesce((policy_score->>'priority_total')::numeric,'Infinity'::numeric)-total)>0.000001
        or abs(coalesce((policy_score->>'served_priority_total')::numeric,'Infinity'::numeric)-served_total)>0.000001
      then raise exception 'invalid_publication_scores'; end if;
    end loop;
  end if;
  -- 20260910091800 (contested waiting-list groups, REQ §7.3): before the snapshot is taken
  -- and before anybody is notified, settle each published day's leftovers — every trivially
  -- satisfiable round-trip request is auto-approved onto a free shared car, and each set of
  -- mutually overlapping requests that cannot all be served becomes one waitlist_groups row
  -- whose members are all told at once. Deliberately placed after the score validation
  -- above (which is checked against the pre-publish board) and before the snapshot below
  -- (so `rides`/`requests` in the siddur version, and the `published` notifications, carry
  -- the final outcome). Idempotent, so re-publishing a day is safe.
  foreach v_day in array v_days loop
    perform public.form_waitlist_groups(p_department_id, p_week_start, v_day);
  end loop;

  select * into v_prev from public.siddur_versions
  where department_id = p_department_id and week_start = p_week_start order by version_no desc limit 1;

  select jsonb_build_object(
    'selected_days',to_jsonb(v_days),
    'published_days',to_jsonb(v_public_days),
    'unanswered_acknowledged',coalesce(p_allow_unanswered,false),
    'scores_scope','whole_board',
    'profile_scores',p_profile_scores,
    'policy_scores',p_policy_scores,
    'policy_version_id',(select current_version_id from public.policies where is_active and (department_id=p_department_id or department_id is null) order by department_id nulls last limit 1),
    'scores_fingerprint',p_expected_fingerprint,
    'rides', (select coalesce(jsonb_agg(to_jsonb(r)), '[]') from public.rides r
              where r.department_id = p_department_id and r.week_start = p_week_start and r.status <> 'cancelled'),
    -- R13U9: a request whose offer lapses at this publish is stored with the status it returns to (the offer's
    -- previous_status), so the next publish does not report "proposed -> waitlisted" as news.
    'requests', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', q.id, 'requester_id', q.requester_id,
                    'status', coalesce(case when q.status = 'proposed'
                        and (coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date = any(v_days) then
                      (select pp.previous_status from public.proposals pp where pp.request_id = q.id and pp.status = 'sent'
                         and (pp.type not in ('shift','merge') or pp.created_via <> 'sadran'
                              or (coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date < (now() at time zone 'Asia/Jerusalem')::date)
                       order by pp.created_at limit 1) end, q.status),
                    'status_reason', q.status_reason)), '[]')
                 from public.requests q where q.department_id = p_department_id and q.week_start = p_week_start),
    'cars', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from public.cars c where c.department_id = p_department_id),
    'blocks', (select coalesce(jsonb_agg(to_jsonb(b)), '[]') from public.car_maintenance_blocks b where b.department_id = p_department_id)
  ) into v_snapshot;

  perform set_config('app.audit_reason', 'publish_siddur', true);

  -- Compute notified_count up front (§ above) — enqueue_notification writes are safe to
  -- run before the siddur_versions row exists since this whole RPC is one transaction:
  -- either everything commits together or everything rolls back together.
  -- 20260910096000 (owner decision, REQ §9): one notification per recipient per publish
  -- call, not one per request. Group every non-cancelled request in scope by requester,
  -- split into a `published` set (day newly public) and an `outcome_changed` set (status
  -- changed since the previous version, on an already-public day), and enqueue at most one
  -- notification of each kind per recipient, listing every affected day/request. The
  -- explicit `days`/`outcomeLine`/`diffLine` vars below win over the single-request
  -- defaults notification_context() would otherwise compute from `data.request_id`
  -- (enqueue_notification does `notification_context(...) || _vars`, right side wins).
  for v_req in
    with scoped as (
      select q.id, q.requester_id, q.status,
        (coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date as request_day,
        (coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date = any(v_prior_days) as day_was_public,
        (select elem ->> 'status' from jsonb_array_elements(coalesce(v_prev.snapshot -> 'requests','[]'::jsonb)) elem
          where (elem ->> 'id')::uuid = q.id) as prev_status,
        coalesce(rd.starts_at,q.depart_at,q.return_at) as line_dt,
        coalesce(rd.starts_at,q.depart_at) as line_depart,
        coalesce(rd.ends_at,q.return_at) as line_return,
        coalesce(c.name,dest.name,q.destination_text,'') as line_place,
        -- R13U9: an offer this publish lapses (the rule of expire_proposals) — its line goes in this notice
        q.status = 'proposed' and exists (select 1 from public.proposals pp where pp.request_id = q.id and pp.status = 'sent'
          and (pp.type not in ('shift','merge') or pp.created_via <> 'sadran'
               or (coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date < (now() at time zone 'Asia/Jerusalem')::date)) as offer_lapses
      from public.requests q
      left join lateral (
        select rr.ride_id from public.ride_requests rr join public.rides x on x.id = rr.ride_id
        where rr.request_id = q.id and x.status <> 'cancelled' limit 1
      ) rl on true
      left join public.rides rd on rd.id = rl.ride_id
      left join public.cars c on c.id = rd.car_id
      left join public.destinations dest on dest.id = q.destination_id
      where q.department_id = p_department_id and q.week_start = p_week_start and q.status not in ('draft','withdrawn','cancelled','external')
        and (coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date = any(v_days)
    ), ride_chg as (
      -- REQ §13.102 R2Q3 / COPY_DRAFT §7: one line per changed ride, old -> new against the previous published
      -- snapshot (rides by id). A ride with no earlier snapshot (or a status change) reads as the new placement.
      select s.id as request_id, s.requester_id, s.request_day, x.id as ride_id,
        public.day_date_label(coalesce(x.starts_at, s.line_dt)) as line_day,
        public.request_route_label(s.id) as route,
        case
          -- REQ §13.204 (a): "removed" only for a request the previous publish showed placed; one that became
          -- waitlisted since gets "on the waiting list"; one filed since the previous publish has no line (its
          -- member was told at filing) - was: every new waitlisted request read publish.removed.
          when x.id is null then case
            when s.prev_status in ('assigned', 'merged') then public._frag('publish.removed')
            when s.prev_status is not null and s.prev_status is distinct from s.status::text and s.status = 'waitlisted'
              then public._frag('publish.now_waitlisted')
            else '' end
          when pv.elem is null or s.prev_status is distinct from s.status::text then
            public._frag('publish.new_ride', jsonb_build_object('car', coalesce((select cc.name from public.cars cc where cc.id = x.car_id), ''),
              'depart', public._hhmm(x.starts_at), 'return', public._hhmm(x.ends_at)))
          else concat_ws(' · ',
            nullif(public._time_change_line((pv.elem ->> 'starts_at')::timestamptz, (pv.elem ->> 'ends_at')::timestamptz, x.starts_at, x.ends_at), ''),
            case when (pv.elem ->> 'car_id')::uuid is distinct from x.car_id then
              public._frag('change.car', jsonb_build_object('newCar', coalesce((select cc.name from public.cars cc where cc.id = x.car_id), ''),
                'oldCar', coalesce((select cc.name from public.cars cc where cc.id = (pv.elem ->> 'car_id')::uuid), ''))) end,
            case when (pv.elem ->> 'driver_id')::uuid is distinct from x.driver_id and x.driver_id is not null then
              public._frag('change.driver', jsonb_build_object('driverName', coalesce((select pf.full_name from public.profiles pf where pf.id = x.driver_id), ''))) end)
        end as line_change
      from scoped s
      left join lateral (
        select r2.* from public.ride_requests rr join public.rides r2 on r2.id = rr.ride_id
        where rr.request_id = s.id and r2.status <> 'cancelled'
      ) x on true
      left join lateral (
        select elem from jsonb_array_elements(coalesce(v_prev.snapshot -> 'rides','[]'::jsonb)) elem
        where (elem ->> 'id')::uuid = x.id limit 1
      ) pv on true
      where v_prev is not null and s.day_was_public
    ), classified as (
      select s.*,
        case when v_prev is null or not day_was_public then 'published'
          when prev_status is distinct from status::text
            or exists (select 1 from ride_chg rc where rc.request_id = s.id and rc.line_change <> '') then 'outcome_changed'
          else null end as event_kind,
        concat_ws(' · ',
          -- a one-way request has no return: its line keeps the day and departure (was: the whole part went null)
          public.day_date_label(line_dt) || ' ' ||
            concat_ws('–', to_char(line_depart at time zone 'Asia/Jerusalem','HH24:MI'),
                           to_char(line_return at time zone 'Asia/Jerusalem','HH24:MI')),
          nullif(line_place,'')
        ) as request_line
      from scoped s
    ), extra_rides as (
      -- RC1B7 (owner 2026-10-29): a newly published ride the member is on without a request of their own on it -
      -- driving it for someone else, or a companion named on a request it serves - is one of "your rides" too
      -- (my-rides lists it). The line is the ride's line as its served request reads it.
      select distinct on (p.pid, x.id) p.pid as requester_id, p.request_id,
        (x.starts_at at time zone 'Asia/Jerusalem')::date as request_day, x.starts_at as line_start,
        public._publish_ride_line(p.request_id, x.id, p.pid) as line
      from public.rides x
      cross join lateral (
        select x.driver_id as pid, rr.request_id from public.ride_requests rr where rr.ride_id = x.id
        union all
        select rc.profile_id, rr.request_id from public.ride_requests rr
        join public.request_companions rc on rc.request_id = rr.request_id where rr.ride_id = x.id
      ) p
      where x.department_id = p_department_id and x.week_start = p_week_start and x.status <> 'cancelled'
        and (x.starts_at at time zone 'Asia/Jerusalem')::date = any(v_days)
        and (v_prev is null or not coalesce((x.starts_at at time zone 'Asia/Jerusalem')::date = any(v_prior_days), false))
        and p.pid is not null
        and not exists (select 1 from public.ride_requests rr2 join public.requests q2 on q2.id = rr2.request_id
                        where rr2.ride_id = x.id and q2.requester_id = p.pid)
      order by p.pid, x.id, p.request_id
    ), pub_ride_lines as (
      -- R5U4: one line per ride the member is on (a pickup is its own ride and its own line); a request with
      -- no live ride keeps its single requested-time line. Rides outside the published days are not listed.
      -- R14B4: one line per ride, even when the request rides it on two legs (two ride_requests rows).
      select distinct on (c.id, x.id) c.requester_id, c.id as request_id, c.request_day, x.starts_at as line_start,
        public._publish_ride_line(c.id, x.id, c.requester_id) as line
      from classified c
      join public.ride_requests rr on rr.request_id = c.id
      join public.rides x on x.id = rr.ride_id and x.status <> 'cancelled'
      where c.event_kind = 'published'
        and (x.starts_at at time zone 'Asia/Jerusalem')::date = any(v_days)
      union all
      -- R10B4: a request with no live ride is not one of "your rides"; a waitlisted one gets its own line
      -- ("on the waiting list: ..."), any other (denied, still open) is left out.
      select c.requester_id, c.id, c.request_day, coalesce(c.line_depart, c.line_dt),
        public._frag(case when c.offer_lapses then 'publish.offer_expired' else 'publish.waitlisted' end, jsonb_build_object('line', c.request_line))
      from classified c
      where c.event_kind = 'published' and (c.status = 'waitlisted' or c.offer_lapses)
        and not exists (select 1 from public.ride_requests rr join public.rides x on x.id = rr.ride_id
                        where rr.request_id = c.id and x.status <> 'cancelled')
      union all
      select e.requester_id, e.request_id, e.request_day, e.line_start, e.line from extra_rides e
    ), days_agg as (
      select requester_id, event_kind, string_agg(public.day_date_label(request_day), ', ' order by request_day) as days_list,
        array_agg(request_day order by request_day) as days_arr
      from (select distinct c.requester_id, c.event_kind, c.request_day from classified c where c.event_kind is not null
        and (c.event_kind <> 'published' or c.status = 'waitlisted' or c.offer_lapses or exists (select 1 from public.ride_requests rr join public.rides x on x.id = rr.ride_id
                where rr.request_id = c.id and x.status <> 'cancelled'))
        union select e.requester_id, 'published', e.request_day from extra_rides e) d
      group by requester_id, event_kind
    ), chg_lines as (
      select rc.requester_id, rc.request_id, rc.request_day,
        public._frag('publish.line', jsonb_build_object('route', rc.route, 'day', rc.line_day, 'changeLine', rc.line_change)) as line,
        row_number() over (partition by rc.requester_id order by rc.request_day, rc.request_id, rc.ride_id) as rn,
        count(*) over (partition by rc.requester_id) as tot
      from ride_chg rc join classified cl on cl.id = rc.request_id and cl.event_kind = 'outcome_changed'
      where rc.line_change <> ''
    ), lines_agg as (
      -- R14B4: an identical line (the same ride reached by two of the member's requests) appears once.
      select requester_id, 'published'::text as event_kind,
        string_agg(line, chr(10) order by line_start, line) as lines,
        (array_agg(request_id order by line_start, request_id))[1] as first_id,
        jsonb_agg(jsonb_build_object('t', line_start, 'line', line) order by line_start, line) as items
      from (select requester_id, line, min(line_start) as line_start, (array_agg(request_id order by line_start, request_id))[1] as request_id
            from pub_ride_lines group by requester_id, line) pl
      group by requester_id
      union all
      select cl.requester_id, 'outcome_changed',
        string_agg(cl.line, chr(10) order by cl.rn) filter (where cl.rn <= 3)
          || case when max(cl.tot) > 3 then chr(10) || public._frag('publish.more', jsonb_build_object('count', (max(cl.tot) - 3)::text)) else '' end,
        (array_agg(cl.request_id order by cl.rn))[1],
        null::jsonb
      from chg_lines cl group by cl.requester_id
    ), per_kind as (
      select l.requester_id, l.event_kind, d.days_list, d.days_arr, l.lines, l.first_id, l.items
      from lines_agg l join days_agg d using (requester_id, event_kind)
    )
    -- R13U9: ONE notice per member per publish — newly published days and changes on days already public share it
    -- (`published` first; its days are disjoint from the changed ones).
    select k.requester_id,
      case when bool_or(k.event_kind = 'published') then 'published' else 'outcome_changed' end as event_kind,
      string_agg(k.days_list, ', ' order by k.event_kind desc) as days_list,
      string_agg(k.lines, chr(10) order by k.event_kind desc) as lines,
      (array_agg(k.first_id order by k.event_kind desc))[1] as first_id,
      (array_agg(k.items) filter (where k.event_kind = 'published'))[1] as items,
      (array_agg(k.lines) filter (where k.event_kind = 'outcome_changed'))[1] as extra,
      (select array_agg(distinct d order by d) from per_kind k2 cross join lateral unnest(k2.days_arr) d where k2.requester_id = k.requester_id) as days_arr
    from per_kind k group by k.requester_id
  loop
    v_event := v_req.event_kind::public.notification_event;
    v_items := coalesce(v_req.items, '[]'::jsonb); v_dates := v_req.days_arr; v_extra := v_req.extra; v_old_ids := null;
    if v_event = 'published' then
      -- R14B3 (owner 2026-10-23, "merge if unread"): publishing in several calls must not send several notices. An
      -- earlier `published` notice of this week that the member has not opened is replaced by this one, which lists
      -- the lines and days of both (identical lines once, in day order); the member was already pushed for it, so the
      -- merged notice is inbox only. One the member opened stays, and the new notice pushes once.
      for v_old in
        select n.id, n.data from public.notifications n
        where n.recipient_id = v_req.requester_id and n.event = 'published' and n.week_start = p_week_start
          and n.read_at is null and n.data ? 'pub_items' order by n.created_at, n.id
      loop
        v_old_ids := array_append(v_old_ids, v_old.id);
        v_items := (v_old.data -> 'pub_items') || v_items;
        v_dates := array(select distinct d from unnest(v_dates || array(select jsonb_array_elements_text(v_old.data -> 'pub_days')::date)) d order by d);
        if coalesce(v_old.data ->> 'pub_extra', '') <> '' then
          v_extra := concat_ws(chr(10), v_old.data ->> 'pub_extra', v_extra);
        end if;
      end loop;
      select string_agg(line, chr(10) order by t, line) into v_lines
      from (select e ->> 'line' as line, min((e ->> 't')::timestamptz) as t from jsonb_array_elements(v_items) e group by e ->> 'line') x;
      if v_extra is not null then
        select string_agg(l, chr(10) order by o) into v_extra
        from (select l, min(o) as o from unnest(string_to_array(v_extra, chr(10))) with ordinality u(l, o) group by l) y;
        v_lines := concat_ws(chr(10), v_lines, v_extra);
      end if;
    else
      v_lines := v_req.lines;
    end if;
    select string_agg(public.day_date_label(d), ', ' order by d) into v_days_txt from unnest(v_dates) d;
    v_notif := public.enqueue_notification(v_req.requester_id, v_event, p_department_id, p_week_start,
      case when v_event = 'published' then jsonb_build_object('days', v_days_txt, 'outcomeLine', v_lines)
        else jsonb_build_object('days', v_days_txt, 'diffLine', v_lines) end,
      case when v_event = 'published' then jsonb_build_object('request_id', v_req.first_id, 'pub_items', v_items,
             'pub_days', to_jsonb(v_dates), 'pub_extra', v_extra)
        else jsonb_build_object('request_id', v_req.first_id) end,
      format('%s:%s:%s', v_event, v_version_id, v_req.requester_id));
    if v_notif is not null and v_old_ids is not null then
      delete from public.notifications where id = any(v_old_ids);
      delete from public.push_outbox where notification_id = v_notif;
    end if;
    v_notified := v_notified + 1;
  end loop;

  insert into public.siddur_versions (id, department_id, week_start, snapshot, published_by, notified_count)
  values (v_version_id, p_department_id, p_week_start, v_snapshot, (select auth.uid()), v_notified);

  perform set_config('app.in_publish', 'on', true);

  v_phase := case when p_week_start <= public.current_week_start() then 'live' else 'published' end;

  update public.weeks set published_version_id = v_version_id, published_at = now(), phase = v_phase, published_days=v_public_days,
    open_at=least(open_at,now()-interval '1 second'),close_at=now(),publish_at=greatest(publish_at,now())
  where department_id = p_department_id and week_start = p_week_start;

  update public.rides set status = 'confirmed'
  where department_id = p_department_id and week_start = p_week_start and status = 'draft'
    and (starts_at at time zone 'Asia/Jerusalem')::date=any(v_days);

  perform set_config('app.in_publish', 'off', true);

  -- New (this migration): the day(s) just published are now public per is_day_public(), so
  -- any `sent` proposal still pending for one of them is settled face-to-face — expire it
  -- now instead of leaving it for the next app.tick().
  perform public.expire_proposals();

  perform set_config('app.publishing', v_prev_publishing, true);
  return v_version_id;
end;
$function$;

create or replace function public.agree_proposals_offline(p_department_id uuid, p_week_start date, p_days date[])
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_id uuid; v_res jsonb; v_applied int := 0; v_waiting int := 0; v_stale int := 0;
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  -- the proposals publication_readiness counts as pending on those days (plan B has its own blocker)
  for v_id in
    select p.id from public.proposals p join public.requests q on q.id = p.request_id
     where p.department_id = p_department_id and p.week_start = p_week_start and p.status = 'sent' and p.type <> 'alternative'
       and (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date = any(p_days)
     order by p.created_at, p.id
  loop
    v_res := public.agree_proposal_offline(v_id);
    if v_res ->> 'status' = 'waiting' then v_waiting := v_waiting + 1;
    elsif v_res ->> 'status' = 'withdrawn_stale' then v_stale := v_stale + 1;
    else v_applied := v_applied + 1; end if;
  end loop;
  return jsonb_build_object('applied', v_applied, 'waiting', v_waiting, 'withdrawn_stale', v_stale);
end $$;
revoke all on function public.agree_proposals_offline(uuid, date, date[]) from public;
grant execute on function public.agree_proposals_offline(uuid, date, date[]) to authenticated;

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select t.event::public.notification_event, ch, t.variant, t.title, t.body, t.title, t.body
from (values
  ('outcome_changed', 'removed_as_driver', '{{byName}} הוריד/ה אותך מהנהיגה — {{day}}',
   'הבקשה שלך לנסיעה הזו בוטלה; הנסיעה עצמה ממשיכה. לשאלות — הסדרן/ית.'),
  ('outcome_changed', 'removed_as_driver_handed', '{{byName}} הוריד/ה אותך מהנהיגה — {{day}}',
   '{{driverName}} ממשיך/ה את הנסיעה במקומך.')
) as t(event, variant, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do nothing;
