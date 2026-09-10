-- Contested waiting-list groups, part 4: the read model for the siddur "בדיון" block and
-- the Sadran board. `security_invoker = true` like every other view, so the RLS of
-- `waitlist_groups` / `waitlist_group_members` (department member + public week, or
-- can_manage_week) decides what comes back. The member snapshot is read from
-- `waitlist_group_members` itself, never from `requests` — see the table comment in
-- 20260910091200_create_waitlist_groups.sql for why.
-- REQ §7.3; DATA_MODEL.md §7, §6.

create or replace view public.v_waitlist_groups with (security_invoker = true) as
select
  g.id, g.department_id, g.week_start, g.day, g.starts_at, g.ends_at, g.status,
  g.ride_id, g.resolved_by, g.resolved_at, g.version, g.created_at, g.updated_at,
  coalesce(jsonb_agg(jsonb_build_object(
    'request_id', m.request_id,
    'profile_id', m.profile_id,
    'name', p.full_name,
    'depart_at', m.depart_at,
    'return_at', m.return_at,
    'adults', m.adults,
    'child_seats', m.child_seats,
    'boosters', m.boosters,
    'destination', m.destination,
    'chosen', m.chosen
  ) order by m.created_at, m.id) filter (where m.id is not null), '[]') as members
from public.waitlist_groups g
left join public.waitlist_group_members m on m.group_id = g.id
left join public.profiles p on p.id = m.profile_id
group by g.id;

grant select on public.v_waitlist_groups to authenticated;
