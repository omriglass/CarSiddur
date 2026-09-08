-- A birth year lets named children be counted correctly in the seat model.
-- The product threshold is eight: from that calendar year onward, a named
-- child uses an ordinary adult seat rather than a child-seat position.
alter table public.children
  add column birth_year smallint;

alter table public.children
  add constraint children_birth_year_ck check (birth_year is null or birth_year between 1900 and 2100);

-- Keep the request's denormalized passenger counts in sync with its named
-- children. Existing unnamed/legacy child seats are preserved. This is an RPC
-- rather than a pair of direct table writes so a changed birth year cannot
-- leave solver input and the selected children disagreeing.
create or replace function public.set_request_children(p_request_id uuid, p_child_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  q public.requests%rowtype;
  v_year int;
  v_old_adult_children int := 0;
  v_old_child_seat_children int := 0;
  v_new_adult_children int := 0;
  v_new_child_seat_children int := 0;
  v_legacy_adults int := 1;
  v_legacy_child_seats int := 0;
begin
  select * into q from public.requests where id = p_request_id for update;
  if not found then raise exception 'request_not_found'; end if;
  if q.requester_id <> auth.uid() and not public.can_manage_week(q.department_id, q.week_start) then
    raise exception 'not_authorized';
  end if;
  if coalesce(cardinality(p_child_ids), 0) is distinct from (
    select count(distinct child_id) from unnest(coalesce(p_child_ids, '{}'::uuid[])) as u(child_id)
  ) then
    raise exception 'duplicate_child';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_child_ids, '{}'::uuid[])) as u(child_id)
    left join public.children c on c.id = u.child_id and c.department_id = q.department_id
    where c.id is null
  ) then raise exception 'invalid_child'; end if;

  v_year := extract(year from coalesce(q.depart_at, now()) at time zone 'Asia/Jerusalem')::int;
  select
    count(*) filter (where c.birth_year is not null and v_year - c.birth_year >= 8),
    count(*) filter (where c.birth_year is null or v_year - c.birth_year < 8)
  into v_old_adult_children, v_old_child_seat_children
  from public.request_children rc join public.children c on c.id = rc.child_id
  where rc.request_id = q.id;

  select
    count(*) filter (where c.birth_year is not null and v_year - c.birth_year >= 8),
    count(*) filter (where c.birth_year is null or v_year - c.birth_year < 8)
  into v_new_adult_children, v_new_child_seat_children
  from public.children c where c.id = any(coalesce(p_child_ids, '{}'::uuid[]));

  v_legacy_adults := greatest(1, q.adults - v_old_adult_children);
  v_legacy_child_seats := greatest(0, q.child_seats - v_old_child_seat_children);

  delete from public.request_children where request_id = q.id;
  insert into public.request_children(request_id, child_id)
    select q.id, child_id from unnest(coalesce(p_child_ids, '{}'::uuid[])) as u(child_id);

  update public.requests
  set adults = v_legacy_adults + v_new_adult_children,
      child_seats = v_legacy_child_seats + v_new_child_seat_children,
      updated_at = now()
  where id = q.id;
end;
$$;

revoke all on function public.set_request_children(uuid, uuid[]) from public;
grant execute on function public.set_request_children(uuid, uuid[]) to authenticated;
