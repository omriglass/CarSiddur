-- REQ §13.101 j: "fewer days for a multi-day request". A Sadran `shift` proposal on a series head may carry
--   { "series_span": { "depart_at": <ts>, "return_at": <ts> }, "car_id": <uuid> }
-- naming a consecutive sub-span of the series' own days. Accepting it shortens the series to those days on that
-- car: the dropped days' requests are withdrawn (status_reason SERIES_SHORTENED, detached from the series) and
-- their rides cancelled; the kept legs are renumbered, the first/last leg take the span's times, and
-- place_series() holds them on the car. Nothing else stays open (pending proposals on the series are withdrawn).
-- `_apply_series_span` does the work for apply_proposal and, inside a rolled-back sub-block, for create_proposal's
-- feasibility probe. Errors: series_span_invalid, series_span_requires_series_head, series_span_shared_ride,
-- and place_series' own series_car_unavailable (MDR03) when the car cannot hold the kept days.
create or replace function public._apply_series_span(p_request_id uuid, p_span jsonb, p_car_id uuid)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_head public.requests%rowtype; v_series uuid;
  v_dep timestamptz; v_ret timestamptz; v_first date; v_last date;
  v_n_in int; v_d_min date; v_d_max date; v_k int; v_i int := 0; v_leg record;
  v_prev_flag text := coalesce(current_setting('app.system_status_transition', true), '');
  v_applying text := coalesce(nullif(current_setting('app.applying_proposal', true), ''), '');
  v_actor uuid := (select auth.uid()); v_prop uuid; v_ride uuid;
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
  if v_first >= v_last then raise exception 'series_span_invalid' using errcode = 'P0001'; end if;

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
end $$;

revoke all on function public._apply_series_span(uuid, jsonb, uuid) from public;
grant execute on function public._apply_series_span(uuid, jsonb, uuid) to service_role;
