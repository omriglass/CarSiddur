-- REQ §13.202 (i), owner 2026-11-09: sharing a child is enough — a child's other guardian edits all of my rides in
-- that department, as if I had named them (no list row, no message; it ends when we no longer share a child).

-- a and b are both guardians of one child of p_department.
create or replace function public._shares_child(p_department uuid, p_a uuid, p_b uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_a is not null and p_b is not null and p_a <> p_b and exists (
    select 1 from public.child_guardians ga
    join public.children c on c.id = ga.child_id and c.department_id = p_department
    join public.child_guardians gb on gb.child_id = ga.child_id and gb.profile_id = p_b
    where ga.profile_id = p_a);
$$;
revoke all on function public._shares_child(uuid, uuid, uuid) from public, anon, authenticated;

create or replace function public._is_ride_editor(p_department uuid, p_owner uuid, p_actor uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_actor is not null and p_owner is not null and p_department is not null and p_actor <> p_owner
    and exists (select 1 from public.department_members dm join public.profiles p on p.id = dm.profile_id
                where dm.department_id = p_department and dm.profile_id = p_actor and dm.removed_at is null
                  and p.approval_status = 'approved')
    and (exists (select 1 from public.ride_editors e
                 where e.department_id = p_department and e.owner_id = p_owner and e.editor_id = p_actor)
         or public._shares_child(p_department, p_owner, p_actor));
$$;
revoke all on function public._is_ride_editor(uuid, uuid, uuid) from public, anon, authenticated;

-- The caller's editor links in both directions, every department: 'mine' = who may edit my rides,
-- 'granted' = whose rides I may edit; `named` = on the list, `co_parent` = through a shared child.
create or replace function public.my_ride_editor_links()
returns table(department_id uuid, person_id uuid, person_name text, direction text, named boolean, co_parent boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  with me as (select (select auth.uid()) as id),
  pairs as (
    select e.department_id, e.editor_id as person_id, 'mine'::text as direction from public.ride_editors e, me where e.owner_id = me.id
    union
    select e.department_id, e.owner_id, 'granted' from public.ride_editors e, me where e.editor_id = me.id
    union
    select c.department_id, other.profile_id, d.direction
    from me
    join public.child_guardians mine on mine.profile_id = me.id
    join public.children c on c.id = mine.child_id
    join public.child_guardians other on other.child_id = mine.child_id and other.profile_id <> me.id
    cross join (values ('mine'), ('granted')) as d(direction)
  )
  select p.department_id, p.person_id, pr.full_name, p.direction,
    exists (select 1 from public.ride_editors e where e.department_id = p.department_id
            and ((p.direction = 'mine' and e.owner_id = me.id and e.editor_id = p.person_id)
              or (p.direction = 'granted' and e.editor_id = me.id and e.owner_id = p.person_id))),
    public._shares_child(p.department_id, me.id, p.person_id)
  from pairs p cross join me
  join public.profiles pr on pr.id = p.person_id
  where public.is_approved()
    and case when p.direction = 'mine' then public._is_ride_editor(p.department_id, me.id, p.person_id)
             else public._is_ride_editor(p.department_id, p.person_id, me.id) end;
$$;
revoke all on function public.my_ride_editor_links() from public, anon;
grant execute on function public.my_ride_editor_links() to authenticated;
