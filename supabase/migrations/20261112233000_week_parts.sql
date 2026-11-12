-- PF1 DC2b/DC2c (docs/PF1_PLAN_2026-11.md §12): one call for the week data a screen reads.
--
-- The board and the siddur each read one department-week through ~10 separate API calls, at open and again after
-- every change. Production's slow-call records show them queuing on the few database connections. `week_parts`
-- returns the asked-for parts in one call; the browser groups the reads that start together (src/lib/weekPartsBatcher.ts).
--
-- Same rows as before, by construction:
--   - SECURITY INVOKER: every table and view is read under the caller's own RLS, exactly like the separate calls;
--   - each part is the same query the browser sent (same filters, same embedded rows, same order);
--   - each part fails on its own: {"error": {code, message, details, hint}} for that part, the others still answer
--     (a member looking at another department gets rides but `not_authorized` from the waiting-list functions, as before).
-- `requests.notes` is not here (closed by column grants, REQ §13.153): the browser still reads `request_notes()`.
-- A new `requests` column goes into the `requests` part too (`week_parts.sql` checks it against the column grants).

create or replace function public.week_parts(p_department_id uuid, p_week_start date, p_parts text[])
returns jsonb
language plpgsql stable
set search_path = public, pg_temp
as $$
declare
  v_out jsonb := '{}'::jsonb;
  v_part text;
  v_data jsonb;
  v_code text;
  v_message text;
  v_details text;
  v_hint text;
begin
  foreach v_part in array coalesce(p_parts, '{}'::text[]) loop
    begin
      case v_part
        when 'week' then
          select to_jsonb(w) into v_data from public.weeks w
           where w.department_id = p_department_id and w.week_start = p_week_start;

        when 'rides' then
          select coalesce(jsonb_agg(to_jsonb(r) order by r.starts_at, r.id), '[]'::jsonb) into v_data
            from public.week_board_rides(p_department_id, p_week_start) r;

        when 'requests' then
          select coalesce(jsonb_agg(x.j), '[]'::jsonb) into v_data from (
            select (select to_jsonb(c) from (select
                     q.id, q.department_id, q.week_start, q.requester_id, q.filed_by, q.destination_id, q.destination_text,
                     q.ride_type_id, q.trip_shape, q.depart_at, q.return_at, q.one_way_car_mode, q.needs_car_at_destination,
                     q.adults, q.child_seats, q.boosters, q.has_luggage, q.needs_tow_hitch, q.flex_depart_early,
                     q.flex_depart_late, q.flex_return_early, q.flex_return_late, q.is_late, q.submitted_at, q.status,
                     q.status_reason, q.changed_since_solve, q.freed_slot_opt_out, q.manual_boost, q.manual_boost_reason,
                     q.join_ride_id, q.template_id, q.version, q.created_at, q.updated_at, q.preferred_car_id,
                     q.original_depart_at, q.original_return_at, q.ride_description, q.guest_passenger_names, q.series_id,
                     q.series_index, q.series_count, q.origin_id, q.origin_text, q.trip_type, q.kept_return_at,
                     q.depart_anchor, q.arrive_by, q.return_anchor, q.leave_dest_at, q.luggage_waived_at,
                     q.luggage_waived_by, q.duration_locked, q.fallback, q.served_by_alternative, q.plan_b_parent_id,
                     q.keep_car_at_destination, q.reserved_at) c)
              || jsonb_build_object(
                'requester', (select jsonb_build_object('full_name', p.full_name, 'does_not_drive', p.does_not_drive)
                                from public.profiles p where p.id = q.requester_id),
                'filer', (select jsonb_build_object('full_name', p.full_name) from public.profiles p where p.id = q.filed_by),
                'destination', (select jsonb_build_object('name', d.name, 'travel_minutes', d.travel_minutes)
                                  from public.destinations d where d.id = q.destination_id),
                'origin', (select jsonb_build_object('name', d.name) from public.destinations d where d.id = q.origin_id),
                'ride_type', (select jsonb_build_object('code', t.code, 'name_he', t.name_he)
                                from public.ride_types t where t.id = q.ride_type_id),
                'preferred_car', (select jsonb_build_object('name', c.name) from public.cars c where c.id = q.preferred_car_id),
                'companions', (select coalesce(jsonb_agg(jsonb_build_object(
                                   'profile_id', rc.profile_id,
                                   'profile', (select jsonb_build_object('full_name', p.full_name, 'does_not_drive', p.does_not_drive)
                                                 from public.profiles p where p.id = rc.profile_id))), '[]'::jsonb)
                                 from public.request_companions rc where rc.request_id = q.id),
                'request_children', (select coalesce(jsonb_agg(jsonb_build_object(
                                   'child', (select jsonb_build_object('full_name', ch.full_name)
                                               from public.children ch where ch.id = rch.child_id))), '[]'::jsonb)
                                 from public.request_children rch where rch.request_id = q.id),
                'stops', (select coalesce(jsonb_agg(jsonb_build_object(
                                   'leg', s.leg, 'position', s.position, 'place_id', s.place_id, 'place_text', s.place_text,
                                   'place', (select jsonb_build_object('name', d.name) from public.destinations d where d.id = s.place_id))
                                 order by s.leg, s.position), '[]'::jsonb)
                            from public.request_stops s where s.request_id = q.id),
                'alternative', (select jsonb_build_object(
                                   'drop_place_id', a.drop_place_id, 'drop_place_text', a.drop_place_text, 'arrive_by', a.arrive_by,
                                   'pickup', a.pickup, 'pickup_at', a.pickup_at, 'pickup_place_id', a.pickup_place_id,
                                   'pickup_place_text', a.pickup_place_text, 'applied_at', a.applied_at,
                                   'drop_place', (select jsonb_build_object('name', d.name) from public.destinations d
                                                   where d.department_id = a.department_id and d.id = a.drop_place_id),
                                   'pickup_place', (select jsonb_build_object('name', d.name) from public.destinations d
                                                     where d.department_id = a.department_id and d.id = a.pickup_place_id))
                                  from public.request_alternatives a where a.request_id = q.id)) as j
              from public.requests q
             where q.department_id = p_department_id and q.week_start = p_week_start) x;

        when 'proposals' then
          select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at desc), '[]'::jsonb) into v_data
            from public.proposals p
           where p.department_id = p_department_id and p.week_start = p_week_start;

        when 'freedOffers' then
          select coalesce(jsonb_agg(to_jsonb(o) || jsonb_build_object(
                   'car', (select jsonb_build_object('name', c.name) from public.cars c where c.id = o.car_id),
                   'cancelled_ride', (select jsonb_build_object('starts_at', r.starts_at, 'ends_at', r.ends_at)
                                        from public.rides r where r.id = o.cancelled_ride_id))
                 order by o.created_at desc), '[]'::jsonb) into v_data
            from public.freed_slot_offers o
           where o.department_id = p_department_id and o.week_start = p_week_start;

        when 'heldNotices' then
          select coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'day', h.day, 'recipient_id', h.recipient_id,
                   'subject_kind', h.subject_kind, 'subject_id', h.subject_id)), '[]'::jsonb) into v_data
            from public.held_notices h
           where h.department_id = p_department_id and h.week_start = p_week_start;

        when 'carLocations' then
          select coalesce(jsonb_agg(to_jsonb(v)), '[]'::jsonb) into v_data
            from public.v_car_locations v
           where v.department_id = p_department_id and v.week_start = p_week_start;

        when 'waitlistGroups' then
          select coalesce(jsonb_agg(to_jsonb(v)), '[]'::jsonb) into v_data
            from public.v_waitlist_groups v
           where v.department_id = p_department_id and v.week_start = p_week_start and v.status = 'open';

        when 'waitlistHolds' then
          select coalesce(jsonb_agg(to_jsonb(h)), '[]'::jsonb) into v_data
            from public.waitlist_group_holds(p_department_id, p_week_start) h;

        when 'siddurWaitlist' then
          select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) into v_data
            from public.siddur_waitlist(p_department_id, p_week_start) s;

        when 'rideChanges' then
          select coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object(
                   'requester', (select jsonb_build_object('full_name', p.full_name) from public.profiles p where p.id = c.requester_id),
                   'parties', (select coalesce(jsonb_agg(to_jsonb(rp)), '[]'::jsonb)
                                 from public.ride_change_parties rp where rp.change_id = c.id))
                 order by c.created_at), '[]'::jsonb) into v_data
            from public.ride_change_requests c
           where c.department_id = p_department_id and c.week_start = p_week_start and c.status = 'pending';

        else
          continue;
      end case;
      v_out := v_out || jsonb_build_object(v_part, jsonb_build_object('data', v_data));
    exception when others then
      get stacked diagnostics v_code = returned_sqlstate, v_message = message_text,
                              v_details = pg_exception_detail, v_hint = pg_exception_hint;
      v_out := v_out || jsonb_build_object(v_part, jsonb_build_object('error', jsonb_build_object(
        'code', v_code, 'message', v_message, 'details', nullif(v_details, ''), 'hint', nullif(v_hint, ''))));
    end;
  end loop;
  return v_out;
end;
$$;

revoke all on function public.week_parts(uuid, date, text[]) from public, anon;
grant execute on function public.week_parts(uuid, date, text[]) to authenticated, service_role;
