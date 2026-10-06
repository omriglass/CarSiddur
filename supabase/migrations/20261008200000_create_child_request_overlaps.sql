-- REQ §13.102 (f), R2M4 support: warn a parent at submit when a child they name is already on
-- another member's live request at overlapping times (matched by normalized child name;
-- the request is still allowed). Read-only; member_of(dept) only.
create or replace function public.child_request_overlaps(
  p_department_id uuid,
  p_child_names text[],
  p_depart_at timestamptz,
  p_return_at timestamptz,
  p_exclude_request_id uuid default null
) returns table(request_id uuid, requester_name text, child_name text, depart_at timestamptz, return_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_names text[];
  v_start timestamptz;
  v_end timestamptz;
begin
  if not public.member_of(p_department_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  select coalesce(array_agg(distinct lower(regexp_replace(btrim(n), '\s+', ' ', 'g'))), '{}')
    into v_names from unnest(coalesce(p_child_names, '{}')) n where btrim(n) <> '';
  if cardinality(v_names) = 0 then return; end if;
  v_start := coalesce(p_depart_at, p_return_at);
  v_end := coalesce(p_return_at, p_depart_at);
  if v_start is null then return; end if;
  if v_end <= v_start then v_end := v_start + interval '1 minute'; end if;

  return query
  select q.id, coalesce(p.full_name, ''), c.full_name, q.depart_at, q.return_at
  from public.requests q
  join public.request_children rc on rc.request_id = q.id
  join public.children c on c.id = rc.child_id
  left join public.profiles p on p.id = q.requester_id
  where q.department_id = p_department_id
    and q.requester_id <> (select auth.uid())
    and (p_exclude_request_id is null or q.id <> p_exclude_request_id)
    and q.status in ('submitted','proposed','assigned','merged','waitlisted','external')
    and lower(regexp_replace(btrim(c.full_name), '\s+', ' ', 'g')) = any (v_names)
    and tstzrange(coalesce(q.depart_at, q.return_at),
                  greatest(coalesce(q.return_at, q.depart_at), coalesce(q.depart_at, q.return_at) + interval '1 minute'))
        && tstzrange(v_start, v_end)
  order by q.depart_at, q.id;
end;
$$;
revoke all on function public.child_request_overlaps(uuid, text[], timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.child_request_overlaps(uuid, text[], timestamptz, timestamptz, uuid) to authenticated;
