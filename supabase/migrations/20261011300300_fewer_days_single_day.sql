-- REQ §13.105 d / QA run 5 R5Q4: "fewer days" for the Sadran goes down to a single day (members already could, REQ §13.103 c).
-- `_apply_series_span` refused first = last (`series_span_invalid`); a one-day span now detaches that day from the series and
-- places it as an ordinary request on the chosen car, withdrawing the other days. Full `create or replace`.
CREATE OR REPLACE FUNCTION public._apply_series_span(p_request_id uuid, p_span jsonb, p_car_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_head public.requests%rowtype; v_series uuid;
  v_dep timestamptz; v_ret timestamptz; v_first date; v_last date;
  v_n_in int; v_d_min date; v_d_max date; v_k int; v_i int := 0; v_leg record;
  v_prev_flag text := coalesce(current_setting('app.system_status_transition', true), '');
  v_applying text := coalesce(nullif(current_setting('app.applying_proposal', true), ''), '');
  v_actor uuid := (select auth.uid()); v_prop uuid; v_ride uuid; v_kept uuid;
begin
  select * into v_head from public.requests where id = p_request_id for update;
  if v_head.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  v_series := v_head.series_id;
  if v_series is null or v_head.series_index is distinct from 1 then
    raise exception 'series_span_requires_series_head' using errcode = 'P0001';
  end if;
  v_dep := nullif(p_span ->> 'depart_at', '')::timestamptz;
  v_ret := nullif(p_span ->> 'return_at', '')::timestamptz;
  if v_dep is null or v_ret is null or p_car_id is null
     or not public.is_quarter_hour(v_dep)
     or not (public.is_quarter_hour(v_ret) or (v_ret at time zone 'Asia/Jerusalem')::time = time '23:59') then
    raise exception 'series_span_invalid' using errcode = 'P0001';
  end if;
  v_first := (v_dep at time zone 'Asia/Jerusalem')::date;
  v_last := (v_ret at time zone 'Asia/Jerusalem')::date;
  -- REQ §13.105 d: down to a single day (first = last), as members can (REQ §13.103 c); only an inverted span is invalid.
  if v_first > v_last or v_ret <= v_dep then raise exception 'series_span_invalid' using errcode = 'P0001'; end if;

  perform 1 from public.requests where series_id = v_series order by id for update;
  select count(*) filter (where d between v_first and v_last), min(d), max(d) into v_n_in, v_d_min, v_d_max
  from (select (q.depart_at at time zone 'Asia/Jerusalem')::date as d from public.requests q
        where q.series_id = v_series and q.status not in ('withdrawn', 'cancelled')) x;
  if v_first < v_d_min or v_last > v_d_max or v_n_in <> (v_last - v_first + 1) then
    raise exception 'series_span_invalid' using errcode = 'P0001';
  end if;
  v_k := v_n_in;

  -- Another request riding a series ride is not ours to cancel.
  if exists (select 1 from public.rides r
             join public.ride_requests rr on rr.ride_id = r.id
             join public.requests q on q.id = rr.request_id
             where r.series_id = v_series and r.status <> 'cancelled' and q.series_id is distinct from v_series) then
    raise exception 'series_span_shared_ride' using errcode = 'P0001';
  end if;

  perform set_config('app.system_status_transition', 'on', true);
  perform set_config('app.audit_reason', 'apply_series_span', true);

  -- Nothing else stays open on the series.
  for v_prop in select p.id from public.proposals p
      where p.request_id in (select q.id from public.requests q where q.series_id = v_series)
        and p.status in ('draft', 'sent', 'accepted') and p.id::text <> v_applying order by p.id loop
    if exists (select 1 from public.proposals where id = v_prop and status = 'draft') then
      update public.proposals set status = 'withdrawn' where id = v_prop;
    else
      perform public.proposal_system_withdraw(v_prop, 'withdrawn_edit');
    end if;
  end loop;

  -- REQ §13.105 d: a single kept day leaves the series: it becomes an ordinary request on the chosen car (the same
  -- shape as the member's own `shorten_series` to one day); every other day is withdrawn.
  if v_first = v_last then
    update public.rides set status = 'cancelled', cancelled_at = now(),
      cancelled_by = coalesce(v_actor, driver_id, created_by), cancel_reason = 'SERIES_SHORTENED'
    where series_id = v_series and status <> 'cancelled';
    delete from public.ride_requests where request_id in (select x.id from public.requests x where x.series_id = v_series);
    select x.id into v_kept from public.requests x where x.series_id = v_series and x.status not in ('withdrawn', 'cancelled')
      and (x.depart_at at time zone 'Asia/Jerusalem')::date = v_first;
    update public.requests set status = 'withdrawn', status_reason = 'SERIES_SHORTENED', series_id = null, series_index = null, series_count = null
    where series_id = v_series and status not in ('withdrawn', 'cancelled') and id <> v_kept;
    update public.requests set series_id = null, series_index = null, series_count = null, status = 'submitted',
      status_reason = 'PROPOSAL_APPLIED_PENDING_ASSIGNMENT', depart_at = v_dep, return_at = v_ret where id = v_kept;
    perform public.place_request_on_car(v_kept, p_car_id, true, v_actor, null, v_dep, v_ret, 'PROPOSAL_APPLIED');
    perform set_config('app.system_status_transition', v_prev_flag, true);
    select rr.ride_id into v_ride from public.ride_requests rr where rr.request_id = v_kept limit 1;
    return v_ride;
  end if;

  -- Rides: every series ride is released (dropped days for good, kept days to be placed again on the car).
  update public.rides set status = 'cancelled', cancelled_at = now(),
    cancelled_by = coalesce(v_actor, driver_id, created_by), cancel_reason = 'SERIES_SHORTENED'
  where series_id = v_series and status <> 'cancelled';

  -- Dropped days: withdrawn with a clear reason and detached from the series.
  update public.requests set status = 'withdrawn', status_reason = 'SERIES_SHORTENED',
    series_id = null, series_index = null, series_count = null
  where series_id = v_series and status not in ('withdrawn', 'cancelled')
    and (depart_at at time zone 'Asia/Jerusalem')::date not between v_first and v_last;

  -- Kept days: renumbered; the first/last leg take the span's own times.
  for v_leg in select q.id, (q.depart_at at time zone 'Asia/Jerusalem')::date as d from public.requests q
      where q.series_id = v_series and q.status not in ('withdrawn', 'cancelled') order by 2 loop
    v_i := v_i + 1;
    update public.requests set series_index = v_i, series_count = v_k,
      depart_at = case when v_i = 1 then v_dep else (v_leg.d::timestamp at time zone 'Asia/Jerusalem') end,
      return_at = case when v_i = v_k then v_ret else ((v_leg.d + time '23:59') at time zone 'Asia/Jerusalem') end
    where id = v_leg.id;
  end loop;

  perform public.place_series(v_series, p_car_id, true, 'PROPOSAL_APPLIED');

  perform set_config('app.system_status_transition', 'on', true);
  update public.requests set status_reason = 'PROPOSAL_APPLIED' where series_id = v_series and status = 'assigned';
  perform set_config('app.system_status_transition', v_prev_flag, true);

  select r.id into v_ride from public.rides r where r.series_id = v_series and r.status <> 'cancelled'
  order by r.starts_at limit 1;
  return v_ride;
end $function$;
