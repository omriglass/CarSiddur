-- OB1 (owner 2026-10-06): the Sadran places a multi-day request by hand. Dropping its card on a car
-- holds that car for every day of the series (the same hold auto-fill makes via place_series);
-- edit_ride keeps refusing series legs one by one. Moving an already placed series is not covered.
create or replace function public.place_series_on_car(p_series_id uuid, p_car_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dept uuid; v_week date; v_requester uuid;
begin
  select q.department_id, min(q.week_start), (array_agg(q.requester_id order by q.series_index))[1]
    into v_dept, v_week, v_requester
  from public.requests q
  where q.series_id = p_series_id
  group by q.department_id;
  if v_dept is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_dept, v_week) then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.cars c where c.id = p_car_id and c.department_id = v_dept) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  perform public.assert_private_car_owner_only(p_car_id, (select auth.uid()), v_requester);
  if exists (select 1 from public.ride_requests rr
             join public.rides r on r.id = rr.ride_id
             join public.requests q on q.id = rr.request_id
             where q.series_id = p_series_id and r.status <> 'cancelled') then
    raise exception 'series_edit_not_supported' using errcode = 'MDR02';
  end if;
  return public.place_series(p_series_id, p_car_id, true, 'SADRAN_MANUAL');
end $$;

revoke all on function public.place_series_on_car(uuid, uuid) from public;
grant execute on function public.place_series_on_car(uuid, uuid) to authenticated;
