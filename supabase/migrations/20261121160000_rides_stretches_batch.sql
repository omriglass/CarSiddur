-- RP1 (owner 2026-11-21): the ride cards (siddur, board, /my) say each complex ride as a flow ("חבר, טל וגל יוצאים
-- מהבית, משאירים את גל בזכרון יעקב…"), built from `ride_stretches`. One call for the week's candidate rides instead of
-- one per ride. Security invoker: each ride goes through `ride_stretches` itself (its own `_ride_route_visible` check -
-- null for a ride the caller may not see). At most 200 rides per call.
create or replace function public.rides_stretches(p_ride_ids uuid[])
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_object_agg(t.id::text, public.ride_stretches(t.id)), '{}'::jsonb)
    from (select distinct u.id from unnest(p_ride_ids[1:200]) as u(id) where u.id is not null) t;
$$;

revoke all on function public.rides_stretches(uuid[]) from public;
grant execute on function public.rides_stretches(uuid[]) to authenticated;
