-- REQ item 246, PF1 (free tier must suffice): request_stop_etas is called for every request row by the week views
-- (via request_stops_with_eta), and running the full timing rule there cost ~6x the old function. Fast paths:
--  * no stops: nothing to return (no route work at all);
--  * stops without any hour or stay: the plain walk — out stops forward from depart_at; return stops forward from
--    leave_dest_at when the return is anchored there ("leave there at"), else backward from return_at. This is
--    exactly what request_schedule gives such a route (stop_hours.sql TEST 9 checks they agree);
--  * otherwise request_schedule (the one timing rule).
create or replace function public.request_stop_etas(p_request_id uuid)
returns table(leg public.ride_leg, "position" smallint, place_id uuid, place_text text, eta timestamptz)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_req public.requests%rowtype;
  v_s jsonb;
  v_p jsonb;
  s record;
  v_t timestamptz;
  v_prev_id uuid; v_prev_text text;
  v_stop_minutes int;
  v_timed boolean;
begin
  if not exists (select 1 from public.request_stops x where x.request_id = p_request_id) then return; end if;
  select exists (select 1 from public.request_stops x where x.request_id = p_request_id
                   and (x.fixed_anchor is not null or x.stay_minutes is not null)) into v_timed;

  if v_timed then
    v_s := public.request_schedule(p_request_id);
    if v_s is null then return; end if;
    for s in select * from public.request_stops x where x.request_id = p_request_id
             order by case x.leg when 'out' then 0 else 1 end, x."position" loop
      v_p := null;
      select e.value into v_p from jsonb_array_elements(v_s -> 'points') e
        where e.value ->> 'key' = s.leg::text || ':' || s."position";
      if v_p is null then continue; end if;
      leg := s.leg; "position" := s."position"; place_id := s.place_id; place_text := s.place_text;
      eta := 'epoch'::timestamptz + make_interval(mins => (case when s.leg = 'out' then v_p ->> 'arrive' else v_p ->> 'leave' end)::int);
      return next;
    end loop;
    return;
  end if;

  select * into v_req from public.requests where id = p_request_id;
  if v_req.id is null then return; end if;
  select stop_minutes into v_stop_minutes from public.department_settings where department_id = v_req.department_id;
  v_stop_minutes := coalesce(v_stop_minutes, 5);

  if v_req.depart_at is not null then
    v_t := v_req.depart_at;
    v_prev_id := v_req.origin_id; v_prev_text := v_req.origin_text;
    for s in select * from public.request_stops x where x.request_id = p_request_id and x.leg = 'out' order by x."position" loop
      v_t := v_t + make_interval(mins => public._place_minutes(v_prev_id, v_prev_text, s.place_id, s.place_text));
      leg := 'out'; "position" := s."position"; place_id := s.place_id; place_text := s.place_text; eta := v_t;
      return next;
      v_t := v_t + make_interval(mins => v_stop_minutes);
      v_prev_id := s.place_id; v_prev_text := s.place_text;
    end loop;
  end if;

  if v_req.return_at is not null then
    if v_req.return_anchor = 'leave' and v_req.leave_dest_at is not null then
      -- forward from leaving the destination; eta = when the car leaves the stop
      v_t := v_req.leave_dest_at;
      v_prev_id := v_req.destination_id; v_prev_text := v_req.destination_text;
      for s in select * from public.request_stops x where x.request_id = p_request_id and x.leg = 'return' order by x."position" loop
        v_t := v_t + make_interval(mins => public._place_minutes(v_prev_id, v_prev_text, s.place_id, s.place_text) + v_stop_minutes);
        leg := 'return'; "position" := s."position"; place_id := s.place_id; place_text := s.place_text; eta := v_t;
        return next;
        v_prev_id := s.place_id; v_prev_text := s.place_text;
      end loop;
    else
      v_t := v_req.return_at;
      v_prev_id := v_req.origin_id; v_prev_text := v_req.origin_text;
      for s in select * from public.request_stops x where x.request_id = p_request_id and x.leg = 'return' order by x."position" desc loop
        v_t := v_t - make_interval(mins => public._place_minutes(s.place_id, s.place_text, v_prev_id, v_prev_text));
        leg := 'return'; "position" := s."position"; place_id := s.place_id; place_text := s.place_text; eta := v_t;
        return next;
        v_t := v_t - make_interval(mins => v_stop_minutes);
        v_prev_id := s.place_id; v_prev_text := s.place_text;
      end loop;
    end if;
  end if;
end;
$$;
