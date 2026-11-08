-- REQ §13.194 (owner 2026-11-08): removing a reservation ("שמירת זמן") from the board can be undone. A reservation
-- serves no request, so removing it (`unassign_ride`, the board's "מחיקת שמירת הזמן" / drag to the list) deletes it -
-- nothing goes back to the waiting list. `unassign_ride` now marks it `cancel_reason = 'RESERVATION_REMOVED'`, and
-- `restore_removed_reservation` puts the same ride back (same id, car, hours, driver, people, notes), so held board
-- notices net out: a removal followed by its undo tells nobody anything.

create or replace function public.unassign_ride(p_ride_id uuid, p_expected_version integer) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.rides%rowtype; ids uuid[];
  v_actor uuid := (select auth.uid());
  v_actor_name text; v_who record;
  v_reservation boolean;
begin
  select * into r from public.rides where id=p_ride_id for update;
  if not found or r.status='cancelled' then raise exception 'ride_not_found'; end if;
  if not public.can_manage_week(r.department_id,r.week_start) then raise exception 'not_authorized'; end if;
  if p_expected_version is null or r.version<>p_expected_version then perform public.raise_stale_version(); end if;
  if exists(select 1 from public.weeks where department_id=r.department_id and week_start=r.week_start and phase='archived') then raise exception 'week_archived'; end if;
  perform set_config('app.audit_reason','unassign_ride',true);
  v_reservation := public.ride_is_reservation(r.id);
  select array_agg(request_id) into ids from public.ride_requests where ride_id=r.id;
  select full_name into v_actor_name from public.profiles where id=v_actor;
  for v_who in
    select q.id as request_id, q.requester_id
    from public.ride_requests rr join public.requests q on q.id=rr.request_id
    where rr.ride_id=r.id and q.requester_id is distinct from v_actor
      and q.status not in ('cancelled','withdrawn','denied','external')
    order by q.id
  loop
    perform public.enqueue_notification(v_who.requester_id,'outcome_changed',r.department_id,r.week_start,
      jsonb_build_object('byName',coalesce(v_actor_name,'')),
      jsonb_build_object('variant','unassigned_by_sadran','request_id',v_who.request_id,'ride_id',r.id),
      format('unassigned_by_sadran:%s:%s:%s',r.id,v_who.request_id,clock_timestamp()));
  end loop;
  for v_who in
    select rp.person_id from public.ride_passengers rp
    where rp.ride_id=r.id and rp.person_id is not null and rp.person_id is distinct from v_actor
  loop
    perform public.enqueue_notification(v_who.person_id,'outcome_changed',r.department_id,r.week_start,
      jsonb_build_object('byName',coalesce(v_actor_name,'')),
      jsonb_build_object('variant','ride_cancelled','ride_id',r.id),
      format('ride_cancelled:%s:%s:%s',r.id,r.version,v_who.person_id));
  end loop;
  update public.rides set status='cancelled',cancelled_at=now(),cancelled_by=v_actor,
    cancel_reason=case when v_reservation then 'RESERVATION_REMOVED' else 'SADRAN_UNASSIGNED' end
  where id=r.id;
  delete from public.ride_requests where ride_id=r.id;
  update public.requests q set status='waitlisted',status_reason='SADRAN_UNASSIGNED' where id=any(ids)
    and q.status not in ('cancelled','withdrawn','denied','external')   -- R7B9: a request that already ended stays ended
    and not exists(select 1 from public.ride_requests rr join public.rides rd on rd.id=rr.ride_id where rr.request_id=q.id and rd.status<>'cancelled');
  perform set_config('app.chain_hint', jsonb_build_object('origin_id',r.origin_id,'destination_id',r.destination_id,
    'starts_at',r.starts_at,'ends_at',r.ends_at)::text, true);
  perform public.assert_car_chain(r.car_id,r.week_start);
end $$;

-- Returns the restored ride's new version (the board's redo removes it again with it).
create or replace function public.restore_removed_reservation(p_ride_id uuid) returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.rides%rowtype;
  v_actor uuid := (select auth.uid());
  v_actor_name text; v_status public.ride_status; v_version integer; v_who record;
begin
  select * into r from public.rides where id = p_ride_id for update;
  if not found or r.status <> 'cancelled' or r.cancel_reason is distinct from 'RESERVATION_REMOVED' then
    raise exception 'ride_not_found' using errcode = 'P0001';
  end if;
  if not public.can_manage_week(r.department_id, r.week_start) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if exists (select 1 from public.weeks where department_id = r.department_id and week_start = r.week_start and phase = 'archived') then
    raise exception 'week_archived' using errcode = 'P0001';
  end if;
  -- The car may have been given to someone else since.
  if exists (select 1 from public.rides o
             where o.car_id = r.car_id and o.id <> r.id and o.status <> 'cancelled' and not o.planning_conflict and not o.draft_hold
               and tstzrange(o.starts_at, o.ends_at, '[)') && tstzrange(r.starts_at, r.ends_at, '[)')) then
    raise exception 'ride_time_overlap' using errcode = 'P0001';
  end if;
  -- The status it had before the removal (draft on an unpublished day, else confirmed/flagged).
  select (a.before ->> 'status')::public.ride_status into v_status from public.audit_log a
  where a.table_name = 'rides' and a.row_id = r.id::text and a.action = 'update'
    and a.after ->> 'status' = 'cancelled' and a.before ->> 'status' <> 'cancelled'
  order by a.id desc limit 1;

  perform set_config('app.audit_reason', 'restore_removed_reservation', true);
  update public.rides set status = coalesce(v_status, 'draft'), cancelled_at = null, cancelled_by = null, cancel_reason = null
  where id = r.id
  returning version into v_version;

  select full_name into v_actor_name from public.profiles where id = v_actor;
  for v_who in
    select distinct rp.person_id from public.ride_passengers rp
    where rp.ride_id = r.id and rp.person_id is not null and rp.person_id is distinct from v_actor
  loop
    perform public.enqueue_notification(v_who.person_id, 'outcome_changed', r.department_id, r.week_start,
      jsonb_build_object('byName', coalesce(v_actor_name, '')),
      jsonb_build_object('variant', 'reservation_added', 'ride_id', r.id),
      format('reservation_added:%s:%s:%s', r.id, v_version, v_who.person_id));
  end loop;
  perform public.assert_car_chain(r.car_id, r.week_start);
  return v_version;
end $$;

revoke all on function public.restore_removed_reservation(uuid) from public;
grant execute on function public.restore_removed_reservation(uuid) to authenticated;
grant execute on function public.restore_removed_reservation(uuid) to service_role;
