-- R16B4 (QA run 16): dragging one leg of a הקפצה beyond its flexibility drafted a shift of the whole request. The board
-- now drafts that leg only (payload `leg`, that leg's time, and `ride_starts_at`/`ride_ends_at` = the leg ride as drawn);
-- like a whole-ride draft (REQ §13.161 b) it frees that ride's old time and holds exactly what the board draws:
--   _proposal_holds_ride: a one-leg shift holds its ride too (a series span still does not)
--   _proposal_car_holds: a shift's held window is `ride_starts_at`/`ride_ends_at` when given
--   _sync_draft_hold: a one-leg shift marks the ride carrying that leg, not "the request's only ride"
-- Full definitions from schema-current.sql.

CREATE OR REPLACE FUNCTION "public"."_proposal_holds_ride"("p" "public"."proposals") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select p.type in ('shift', 'origin') and p.status in ('draft', 'sent', 'accepted') and p.applied_at is null
    and nullif(p.payload ->> 'car_id', '') is not null
    and (nullif(p.payload ->> 'depart_at', '') is not null or nullif(p.payload ->> 'return_at', '') is not null)
    and not (p.payload ? 'series_span')
$$;

CREATE OR REPLACE FUNCTION "public"."_proposal_car_holds"("p_payload" "jsonb", "p_type" "public"."proposal_type") RETURNS TABLE("car_id" "uuid", "from_at" timestamp with time zone, "to_at" timestamp with time zone)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_dep timestamptz; v_arr timestamptz; v_pick timestamptz; v_ret timestamptz; v_dur interval; v_car uuid; v_ret_car uuid;
begin
  v_car := nullif(p_payload ->> 'car_id', '')::uuid;
  if v_car is null then return; end if;
  v_dep := nullif(p_payload ->> 'depart_at', '')::timestamptz;
  v_ret := nullif(p_payload ->> 'return_at', '')::timestamptz;
  if p_type = 'alternative' then
    v_arr := nullif(p_payload ->> 'arrive_by', '')::timestamptz;
    if v_dep is null or v_arr is null then return; end if;
    v_dur := greatest(v_arr - v_dep, interval '15 minutes');
    car_id := v_car; from_at := v_dep; to_at := v_arr; return next;
    v_pick := nullif(p_payload ->> 'pickup_at', '')::timestamptz;
    if coalesce((p_payload ->> 'pickup')::boolean, false) and v_pick is not null then
      v_ret_car := coalesce(nullif(p_payload ->> 'return_car_id', '')::uuid, v_car);
      car_id := v_ret_car; from_at := least(v_pick, coalesce(v_ret, v_pick)); to_at := greatest(v_pick, coalesce(v_ret, v_pick)) + v_dur; return next;
    end if;
  elsif p_type in ('shift', 'origin') then
    if coalesce(v_dep, v_ret) is null then return; end if;
    -- R16B4: a one-leg shift of a placed ride carries the leg ride's window as the board draws it.
    car_id := v_car;
    from_at := coalesce(nullif(p_payload ->> 'ride_starts_at', '')::timestamptz, v_dep, v_ret);
    to_at := coalesce(nullif(p_payload ->> 'ride_ends_at', '')::timestamptz, v_ret, v_dep + interval '2 hours');
    return next;
  end if;
end $$;

CREATE OR REPLACE FUNCTION "public"."_sync_draft_hold"("p_request_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_prop public.proposals%rowtype; v_ride uuid; r public.rides%rowtype; v_ids uuid[]; v_who record; v_to uuid; v_by text;
  v_prev text := coalesce(current_setting('app.system_status_transition', true), 'off');
begin
  if p_request_id is null then return; end if;
  select * into v_prop from public.proposals p
  where p.request_id = p_request_id and public._proposal_holds_ride(p)
  order by (p.status = 'draft'), p.created_at desc limit 1;
  -- R16B4: a one-leg shift holds the ride carrying that leg (the other leg's ride is untouched).
  if v_prop.id is not null and v_prop.payload ->> 'leg' in ('out', 'return') then
    select rd.id into v_ride from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
    where rr.request_id = p_request_id and rd.status <> 'cancelled'
      and case when v_prop.payload ->> 'leg' = 'out' then rr.covers_out else rr.covers_return end
    order by (rd.id::text = coalesce(v_prop.payload ->> 'ride_id', '')) desc, rd.id limit 1;
  elsif v_prop.id is not null
     and (select count(*) from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
          where rr.request_id = p_request_id and rd.status <> 'cancelled') = 1 then
    select rd.id into v_ride from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
    where rr.request_id = p_request_id and rd.status <> 'cancelled';
  end if;
  if v_ride is not null then
    update public.rides set draft_hold = true where id = v_ride and not draft_hold;
  end if;

  -- Rides of this request still held but no longer by an open proposal.
  for r in
    select rd.* from public.rides rd
    where rd.draft_hold and rd.id is distinct from v_ride
      and (rd.status = 'cancelled' or exists (select 1 from public.ride_requests rr where rr.ride_id = rd.id and rr.request_id = p_request_id))
      and not exists (select 1 from public.ride_requests rr join public.proposals p on p.request_id = rr.request_id
                      where rr.ride_id = rd.id and rr.request_id <> p_request_id and public._proposal_holds_ride(p))
    order by rd.id for update
  loop
    if r.status = 'cancelled' then
      update public.rides set draft_hold = false where id = r.id;
      continue;
    end if;
    select coalesce(array_agg(request_id), '{}') into v_ids from public.ride_requests where ride_id = r.id;
    if exists (select 1 from public.rides o where o.car_id = r.car_id and o.id <> r.id and o.status <> 'cancelled'
                 and not o.draft_hold and not o.planning_conflict
                 and not (r.series_id is not null and o.series_id = r.series_id)
                 and tstzrange(o.starts_at, o.blocked_until, '[)') && tstzrange(r.starts_at, r.blocked_until, '[)'))
       or public._draft_hold_conflict(r.car_id, r.starts_at, r.blocked_until, v_ids)
       or exists (select 1 from public.car_maintenance_blocks b where b.car_id = r.car_id
                    and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(r.starts_at, r.blocked_until, '[)')) then
      -- Its time was taken while the change was open: released, never double-booked.
      select p.* into v_prop from public.proposals p where p.request_id = any(v_ids) and p.type in ('shift', 'origin')
      order by p.updated_at desc limit 1;
      select full_name into v_by from public.profiles where id = v_prop.created_by;
      for v_who in select distinct q.id as request_id, q.requester_id from public.requests q where q.id = any(v_ids)
        and q.requester_id is distinct from (select auth.uid()) loop
        perform public.enqueue_notification(v_who.requester_id, 'outcome_changed', r.department_id, r.week_start,
          jsonb_build_object('byName', coalesce(v_by, '')),
          jsonb_build_object('variant', 'unassigned_by_sadran', 'request_id', v_who.request_id, 'ride_id', r.id),
          format('unassigned_by_sadran:%s:%s:%s', r.id, v_who.request_id, clock_timestamp()));
      end loop;
      perform set_config('app.audit_reason', 'draft_slot_taken', true);
      perform set_config('app.system_status_transition', 'on', true);
      update public.rides set status = 'cancelled', cancelled_at = now(), cancel_reason = 'DRAFT_SLOT_TAKEN', draft_hold = false,
        cancelled_by = coalesce((select auth.uid()), v_prop.created_by, r.created_by)
      where id = r.id;
      delete from public.ride_requests where ride_id = r.id;
      update public.requests q set status = 'waitlisted', status_reason = 'DRAFT_SLOT_TAKEN'
      where q.id = any(v_ids) and q.status not in ('cancelled', 'withdrawn', 'external', 'denied')
        and not exists (select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
                        where rr.request_id = q.id and rd.status <> 'cancelled');
      perform set_config('app.system_status_transition', v_prev, true);
      if v_prop.id is not null then
        for v_to in select distinct x from unnest(array[v_prop.created_by, v_prop.sent_by]) x
                    where x is not null and x is distinct from (select auth.uid()) loop
          perform public.enqueue_notification(v_to, 'proposal_answered', v_prop.department_id, v_prop.week_start,
            jsonb_build_object('byName', coalesce(v_by, '')),
            jsonb_build_object('variant', 'declined_slot_taken', 'proposal_id', v_prop.id, 'request_id', v_prop.request_id),
            format('declined_slot_taken:%s:%s', v_prop.id, v_to));
        end loop;
      end if;
      perform public.flag_car_chain_breaks(r.car_id, r.week_start);
    else
      update public.rides set draft_hold = false where id = r.id;
    end if;
  end loop;
end $$;
