-- CM1 limit (REQ item 260; docs/TODO.md CM1 "Phase 2 known limits"): when the base (long) trip leaves a chained ride
-- (cancelled, withdrawn, re-placed elsewhere) the chain was cleared but the ride kept the chain's long window. The
-- chained trip now gets its own hours back, the mirror of what unmerge does for the base (`_unmerge_core`): one that
-- rode first (`before`) ends at its own return again, one that rode last (`after`) starts at its own departure again.

CREATE OR REPLACE FUNCTION "public"."ride_requests_chain_cleanup"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_was_base uuid; c record; v_ride public.rides%rowtype; v_start timestamptz; v_end timestamptz;
begin
  if old.chain is not null then return null; end if;
  if not exists (select 1 from public.ride_requests rr where rr.ride_id = old.ride_id and rr.chain is not null) then return null; end if;
  if exists (select 1 from public.ride_requests rr where rr.ride_id = old.ride_id and rr.request_id = old.request_id) then return null; end if;
  select y.request_id into v_was_base from (
      select rr.request_id, rr.role, rr.created_at from public.ride_requests rr where rr.ride_id = old.ride_id and rr.chain is null
      union all select old.request_id, old.role, old.created_at) y
   order by (y.role = 'driver') desc, y.created_at, y.request_id limit 1;
  if v_was_base = old.request_id
     or not exists (select 1 from public.ride_requests rr where rr.ride_id = old.ride_id and rr.chain is null) then
    select * into v_ride from public.rides where id = old.ride_id;
    for c in select rr.chain, q.depart_at, q.return_at from public.ride_requests rr join public.requests q on q.id = rr.request_id
              where rr.ride_id = old.ride_id and rr.chain is not null limit 1 loop
      if v_ride.id is not null and v_ride.status <> 'cancelled' then
        v_start := v_ride.starts_at; v_end := v_ride.ends_at;
        if c.chain like 'after%' and c.depart_at is not null then v_start := greatest(v_ride.starts_at, c.depart_at); end if;
        if c.chain like 'before%' and c.return_at is not null then
          v_end := least(v_ride.ends_at, public._round_up_ride_end(v_start, c.return_at));
        end if;
        if v_end > v_start and (v_start, v_end) is distinct from (v_ride.starts_at, v_ride.ends_at) then
          update public.rides set starts_at = v_start, ends_at = v_end where id = old.ride_id;
        end if;
      end if;
    end loop;
    update public.ride_requests set chain = null where ride_id = old.ride_id and chain is not null;
  end if;
  return null;
end $$;
