-- PS1 (owner 2026-11-22): "+ נוסעים" asks "לX יש נסיעה ברשימת המתנה באותו זמן לאותו מקום. להשאיר אותה ברשימת המתנה,
-- בנוסף לנסיעה הזאת?" - so a request matches the ride only when it goes to the same place too: its destination is the
-- ride's own, one of the ride's served requests' destinations, or one of their stops. Hours as before (with flexibility).
CREATE OR REPLACE FUNCTION "public"."_ride_matching_request"("p_ride_id" "uuid", "p_person_id" "uuid") RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select q.id from public.requests q join public.rides r on r.id = p_ride_id
  where q.requester_id = p_person_id and q.department_id = r.department_id
    and q.week_start = r.week_start and q.status in ('submitted', 'waitlisted', 'proposed')
    and q.depart_at is not null
    and not exists (select 1 from public.ride_requests rr where rr.request_id = q.id and rr.ride_id = p_ride_id)
    and tstzrange(q.depart_at - q.flex_depart_early, coalesce(q.return_at, q.depart_at + interval '1 minute') + q.flex_return_late, '[)')
        && tstzrange(r.starts_at, r.ends_at, '[)')
    and q.destination_id is not null
    and (q.destination_id = r.destination_id
         or exists (select 1 from public.ride_requests rr join public.requests s on s.id = rr.request_id
                    where rr.ride_id = p_ride_id and s.destination_id = q.destination_id)
         or exists (select 1 from public.ride_requests rr join public.request_stops st on st.request_id = rr.request_id
                    where rr.ride_id = p_ride_id and st.place_id = q.destination_id))
  order by q.depart_at, q.id limit 1;
$$;
