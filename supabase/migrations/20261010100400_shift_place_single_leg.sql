-- REQ §13.104 / QA run 4 R4B4 (UI hand-off): a shift proposal from a single-leg card (a הקפצה's pickup or out card)
-- carries `leg` ('out'|'return') plus only that leg's time. Applying it moves/places ONLY that leg on the named
-- car; the other leg's ride is left untouched (`app.place_only_leg`, see 20261010100350).
create or replace function public._shift_place_on_car(p_proposal_id uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p public.proposals%rowtype; q public.requests%rowtype; v_leg text; v_old record; v_prev text; v_res uuid;
begin
  select * into p from public.proposals where id = p_proposal_id;
  select * into q from public.requests where id = p.request_id;
  v_leg := nullif(p.payload ->> 'leg', '');
  if v_leg in ('out', 'return') and q.trip_type = 'drop_off' then
    for v_old in
      select rd.id from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
      where rr.request_id = q.id and rr.leg = v_leg::public.ride_leg and rd.status <> 'cancelled'
      order by rd.id for update of rd
    loop
      if exists(select 1 from public.ride_requests where ride_id = v_old.id and request_id <> q.id) then
        if p.created_via <> 'sadran' then raise exception 'shared_ride_requires_sadran' using errcode = 'P0001'; end if;
      else
        update public.rides set status = 'cancelled', cancelled_at = now(),
          cancelled_by = coalesce(p.created_by, q.requester_id), cancel_reason = 'REPLACED_BY_PROPOSAL' where id = v_old.id;
      end if;
      delete from public.ride_requests where ride_id = v_old.id and request_id = q.id and leg = v_leg::public.ride_leg;
    end loop;
    -- Only this leg is (re)placed (); the other leg's ride stays exactly as it was.
    v_prev := coalesce(current_setting('app.place_only_leg', true), '');
    perform set_config('app.place_only_leg', v_leg, true);
    v_res := public.place_request_on_car(p.request_id, (p.payload ->> 'car_id')::uuid, p.created_via = 'sadran', p.created_by,
      nullif(p.payload ->> 'driver_id', '')::uuid,
      case when v_leg = 'out' then nullif(p.payload ->> 'depart_at', '')::timestamptz end,
      case when v_leg = 'return' then nullif(p.payload ->> 'return_at', '')::timestamptz end, 'PROPOSAL_APPLIED');
    perform set_config('app.place_only_leg', v_prev, true);
    return v_res;
  end if;
  return public.place_request_on_car(p.request_id, (p.payload ->> 'car_id')::uuid, p.created_via = 'sadran', p.created_by,
    nullif(p.payload ->> 'driver_id', '')::uuid, nullif(p.payload ->> 'depart_at', '')::timestamptz,
    nullif(p.payload ->> 'return_at', '')::timestamptz, 'PROPOSAL_APPLIED');
end $$;
