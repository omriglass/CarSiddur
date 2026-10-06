-- REQ §13.103 c: the requester shortens a multi-day series to a consecutive sub-span of 1..n-1 days.
-- 2+ days: _apply_series_span() (unchanged) after the series' own ride_requests rows are removed
-- (their unique (request_id) index otherwise blocks re-placing a kept day on the same car).
-- 1 day: the kept day becomes an ordinary one-day request on the same car.
create or replace function public.shorten_series(p_request_id uuid, p_depart_at timestamptz, p_return_at timestamptz)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  q public.requests%rowtype; v_head uuid; v_car uuid; v_ride uuid; s record; v_prop uuid;
  v_first date; v_last date; v_d_min date; v_d_max date; v_n_in int; v_kept uuid;
  v_actor uuid := (select auth.uid());
  v_prev_flag text := coalesce(current_setting('app.system_status_transition', true), '');
  v_applying text := coalesce(nullif(current_setting('app.applying_proposal', true), ''), '');
begin
  select * into q from public.requests where id = p_request_id;
  if q.id is null or q.series_id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if q.requester_id is distinct from v_actor then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  select id into v_head from public.requests where series_id = q.series_id and series_index = 1;
  select r.car_id into v_car from public.rides r where r.series_id = q.series_id and r.status <> 'cancelled' order by r.starts_at limit 1;
  if v_car is null or p_depart_at is null or p_return_at is null then raise exception 'series_span_invalid' using errcode = 'P0001'; end if;
  v_first := (p_depart_at at time zone 'Asia/Jerusalem')::date;
  v_last := (p_return_at at time zone 'Asia/Jerusalem')::date;
  select count(*) filter (where d between v_first and v_last), min(d), max(d) into v_n_in, v_d_min, v_d_max
  from (select (x.depart_at at time zone 'Asia/Jerusalem')::date as d from public.requests x
        where x.series_id = q.series_id and x.status not in ('withdrawn', 'cancelled')) y;
  if v_first > v_last or v_first < v_d_min or v_last > v_d_max or v_n_in <> (v_last - v_first + 1)
     or p_return_at <= p_depart_at or not public.is_quarter_hour(p_depart_at)
     or not (public.is_quarter_hour(p_return_at) or (p_return_at at time zone 'Asia/Jerusalem')::time = time '23:59') then
    raise exception 'series_span_invalid' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.rides r join public.ride_requests rr on rr.ride_id = r.id join public.requests x on x.id = rr.request_id
             where r.series_id = q.series_id and r.status <> 'cancelled' and x.series_id is distinct from q.series_id) then
    raise exception 'series_span_shared_ride' using errcode = 'P0001';
  end if;
  perform set_config('app.audit_reason', 'shorten_series', true);

  if v_first = v_last then
    perform 1 from public.requests where series_id = q.series_id order by id for update;
    perform set_config('app.system_status_transition', 'on', true);
    for v_prop in select p.id from public.proposals p
        where p.request_id in (select x.id from public.requests x where x.series_id = q.series_id)
          and p.status in ('draft', 'sent', 'accepted') and p.id::text <> v_applying order by p.id loop
      if exists (select 1 from public.proposals where id = v_prop and status = 'draft') then
        update public.proposals set status = 'withdrawn' where id = v_prop;
      else
        perform public.proposal_system_withdraw(v_prop, 'withdrawn_edit');
      end if;
    end loop;
    update public.rides set status = 'cancelled', cancelled_at = now(), cancelled_by = coalesce(v_actor, driver_id, created_by),
      cancel_reason = 'SERIES_SHORTENED' where series_id = q.series_id and status <> 'cancelled';
    delete from public.ride_requests where request_id in (select x.id from public.requests x where x.series_id = q.series_id);
    select x.id into v_kept from public.requests x where x.series_id = q.series_id and x.status not in ('withdrawn', 'cancelled')
      and (x.depart_at at time zone 'Asia/Jerusalem')::date = v_first;
    update public.requests set status = 'withdrawn', status_reason = 'SERIES_SHORTENED', series_id = null, series_index = null, series_count = null
    where series_id = q.series_id and status not in ('withdrawn', 'cancelled') and id <> v_kept;
    update public.requests set series_id = null, series_index = null, series_count = null, status = 'submitted',
      depart_at = p_depart_at, return_at = p_return_at where id = v_kept;
    perform public.place_request_on_car(v_kept, v_car, false, v_actor, null, p_depart_at, p_return_at, 'SERIES_SHORTENED');
    perform set_config('app.system_status_transition', v_prev_flag, true);
    select rr.ride_id into v_ride from public.ride_requests rr where rr.request_id = v_kept limit 1;
  else
    perform set_config('app.system_status_transition', 'on', true);
    delete from public.ride_requests where request_id in (select x.id from public.requests x where x.series_id = q.series_id);
    perform set_config('app.system_status_transition', v_prev_flag, true);
    v_ride := public._apply_series_span(v_head, jsonb_build_object('depart_at', p_depart_at, 'return_at', p_return_at), v_car);
  end if;

  for s in select sp.profile_id from public.sadranim_of(q.department_id, q.week_start) as sp(profile_id) loop
    perform public.enqueue_notification(s.profile_id, 'request_changed', q.department_id, q.week_start,
      jsonb_build_object('requestId', coalesce(v_kept, v_head)::text), jsonb_build_object('request_id', coalesce(v_kept, v_head)),
      format('series_shortened:%s:%s', q.series_id, now()));
  end loop;
  return v_ride;
end $$;
revoke all on function public.shorten_series(uuid, timestamptz, timestamptz) from public;
grant execute on function public.shorten_series(uuid, timestamptz, timestamptz) to authenticated;
