-- REQ §13.134: /my "children's rides" also shows the rides of a child's OTHER guardians. child_guardians rows of other
-- guardians are hidden from members by RLS, so a DB-side reader returns just the co-guardians (approved, active members
-- of the department) of the children I guard.
CREATE OR REPLACE FUNCTION public.my_co_guardians(p_department_id uuid)
RETURNS TABLE(profile_id uuid, child_id uuid, display_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
declare v_actor uuid := (select auth.uid());
begin
  if not public.is_approved() or not public.member_of(p_department_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  return query
    select other.profile_id, other.child_id, coalesce(nullif(trim(pr.display_name), ''), pr.full_name)
    from public.child_guardians mine
    join public.children c on c.id = mine.child_id and c.department_id = p_department_id
    join public.child_guardians other on other.child_id = mine.child_id and other.profile_id <> v_actor
    join public.profiles pr on pr.id = other.profile_id and pr.approval_status = 'approved'
    join public.department_members dm on dm.profile_id = other.profile_id and dm.department_id = p_department_id and dm.removed_at is null
    where mine.profile_id = v_actor
    order by other.child_id, other.profile_id;
end $$;

REVOKE ALL ON FUNCTION public.my_co_guardians(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_co_guardians(uuid) TO authenticated;
