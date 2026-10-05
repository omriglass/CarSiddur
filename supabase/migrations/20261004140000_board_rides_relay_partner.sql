-- REQ §13.93 "Display": a הקפצה relay pair's driver labels should name the partner and the
-- time ("משאיר/ה את הרכב בחריש ליוסי (9:00)" / "הרכב מחכה לך בחריש — דנה מביאה אותו ב-8:40"),
-- not just the place (src/lib/rideLabel.ts's documented simplification). `v_board_rides` gains
-- `relay_partner jsonb`, appended at the end of the column list: for a ride carrying a relay
-- out-leg to X (ends at X, origin <> destination), the next non-cancelled ride on the same car
-- the same Asia/Jerusalem day that starts at X; for a ride carrying a relay return leg starting
-- at X, the previous ride on the same car the same day that ends at X. `{ ride_id, name, at }` —
-- name is the partner ride's own driver, else its first requester (same profiles.full_name
-- source the view already uses). Null when this ride carries no relay leg, or no matching ride
-- is found yet.
--
-- Wrap-and-append idiom (pg_get_viewdef), same as 20261004100800_views_origin_trip_type.sql /
-- 20260910093900_series_columns_in_views.sql — every existing column/order is untouched (hard
-- rule 8).
do $migration$
declare def text; new_view text;
begin
  def := regexp_replace(pg_get_viewdef('public.v_board_rides'::regclass, true), ';\s*$', '');
  new_view := $sql1$create or replace view public.v_board_rides with (security_invoker = true) as
    select existing.*, rp.relay_partner
    from ($sql1$ || def || $sql2$) existing
    left join lateral (
      select jsonb_build_object('ride_id', x.ride_id, 'name', coalesce(x.driver_name, x.first_requester), 'at', x.at) as relay_partner
      from (
        ( select nr.id as ride_id, nr.starts_at as at, dp.full_name as driver_name,
            ( select p.full_name from public.ride_requests rr
                join public.requests q on q.id = rr.request_id
                join public.profiles p on p.id = q.requester_id
               where rr.ride_id = nr.id order by rr.created_at limit 1 ) as first_requester
          from public.rides nr
          left join public.profiles dp on dp.id = nr.driver_id
          where exists (
              select 1 from jsonb_array_elements(existing.served) e
              where e->>'role' = 'driver' and e->>'car_mode' = 'relay' and e->>'leg' = 'out'
            )
            and nr.id <> existing.id
            and nr.car_id = existing.car_id and nr.department_id = existing.department_id
            and nr.week_start = existing.week_start and nr.status <> 'cancelled'
            and nr.origin_id = existing.destination_id
            and (nr.starts_at at time zone 'Asia/Jerusalem')::date = (existing.ends_at at time zone 'Asia/Jerusalem')::date
          order by nr.starts_at limit 1 )
        union all
        ( select pr.id as ride_id, pr.ends_at as at, dp2.full_name as driver_name,
            ( select p.full_name from public.ride_requests rr
                join public.requests q on q.id = rr.request_id
                join public.profiles p on p.id = q.requester_id
               where rr.ride_id = pr.id order by rr.created_at limit 1 ) as first_requester
          from public.rides pr
          left join public.profiles dp2 on dp2.id = pr.driver_id
          where exists (
              select 1 from jsonb_array_elements(existing.served) e
              where e->>'role' = 'driver' and e->>'car_mode' = 'relay' and e->>'leg' = 'return'
            )
            and pr.id <> existing.id
            and pr.car_id = existing.car_id and pr.department_id = existing.department_id
            and pr.week_start = existing.week_start and pr.status <> 'cancelled'
            and pr.destination_id = existing.origin_id
            and (pr.ends_at at time zone 'Asia/Jerusalem')::date = (existing.starts_at at time zone 'Asia/Jerusalem')::date
          order by pr.ends_at desc limit 1 )
      ) x
      limit 1
    ) rp on true$sql2$;
  execute new_view;
end;
$migration$;

grant select on public.v_board_rides to authenticated;
revoke all on public.v_board_rides from anon;
