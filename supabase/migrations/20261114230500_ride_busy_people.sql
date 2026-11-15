-- R20U7 (QA run 20): assigning a volunteer driver was trial and error — the board marked "busy" from the week it shows,
-- while `set_ride_driver` asks "person_busy" from every ride the person is on (any week, any department, their own leg's
-- hours). `ride_busy_people` returns the department's members that the same check (`_person_busy_rides`) finds busy during
-- the ride, so the picker lists the free ones first and marks the rest. Read-only; the Sadran of the ride's week (or an admin).
create or replace function public.ride_busy_people(p_ride_id uuid)
returns setof uuid
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare r public.rides%rowtype;
begin
  select * into r from public.rides where id = p_ride_id;
  if r.id is null or not public.can_manage_week(r.department_id, r.week_start) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return query
    select m.profile_id from public.department_members m
    where m.department_id = r.department_id and m.removed_at is null
      and exists (select 1 from public._person_busy_rides(m.profile_id, tstzrange(r.starts_at, r.ends_at, '[)'), r.id))
    order by m.profile_id;
end $$;

revoke all on function public.ride_busy_people(uuid) from public;
grant execute on function public.ride_busy_people(uuid) to authenticated;
