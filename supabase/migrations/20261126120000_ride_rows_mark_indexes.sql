-- SW1: the ride_rows_mark triggers run per changed row, so their lookups must be indexed. A bulk write (a full
-- apply_solver_result: ~100 rides, ~300 ride_requests rows) ran them as table scans and passed the 8 s API limit
-- once in the QA regression.
--   * a request's rides: ride_requests had only partial indexes on request_id (covers_out / covers_return).
--   * relay neighbours on a car-week: only non-cancelled rides (a cancelled ride has no stored row), so the
--     existing partial index rides_car_chain_idx (car_id, week_start, starts_at) where status <> 'cancelled' applies.

create index if not exists ride_requests_request_idx on public.ride_requests (request_id);

create or replace function public._ride_rows_mark(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_ids is null or cardinality(p_ids) = 0 then return; end if;
  insert into public.ride_rows_dirty (txid, ride_id)
  select txid_current(), x.id
    from (select unnest(p_ids) as id
          union
          select n.id
            from public.rides r
            join public.rides n on n.car_id = r.car_id and n.week_start = r.week_start
                               and n.status <> 'cancelled'
                               and n.department_id = r.department_id and n.id <> r.id
           where r.id = any(p_ids)
             and exists (select 1 from public.ride_requests e
                          where e.ride_id = n.id and e.role = 'driver' and e.car_mode = 'relay')) x
   where x.id is not null
  on conflict do nothing;
end $$;

create or replace function public._ride_rows_mark_car_week(p_department_id uuid, p_car_id uuid, p_week_start date)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_car_id is null then return; end if;
  insert into public.ride_rows_dirty (txid, ride_id)
  select txid_current(), n.id
    from public.rides n
   where n.car_id = p_car_id and n.week_start = p_week_start and n.status <> 'cancelled'
     and n.department_id = p_department_id
     and exists (select 1 from public.ride_requests e
                  where e.ride_id = n.id and e.role = 'driver' and e.car_mode = 'relay')
  on conflict do nothing;
end $$;
