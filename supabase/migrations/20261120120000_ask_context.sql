-- REQ item 258 (e): what "Ask in words" may send about the caller — read as the caller (security invoker, so their
-- own RLS applies), refused unless the admin opted them in and they belong to the department.
-- Returns the department's home and places, the caller's children and the people they usually ride with, and
-- their own upcoming rides (requester, filer or companion) for the next 15 days. Never a note to the Sadran.
-- The `ask` edge function turns request ids into RIDE_n references before anything reaches the model.
create or replace function public.ask_context(p_department_id uuid, p_now timestamptz default now())
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_me uuid := (select auth.uid());
  v_home text;
begin
  if v_me is null or not exists (select 1 from public.ask_access a where a.profile_id = v_me) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if not public.member_of(p_department_id) then raise exception 'not_authorized' using errcode = 'P0001'; end if;

  select d.name into v_home
  from public.departments dep join public.destinations d on d.id = dep.home_destination_id
  where dep.id = p_department_id;

  return jsonb_build_object(
    'home', coalesce(v_home, ''),
    'places', coalesce((
      select jsonb_agg(jsonb_build_object('name', d.name, 'aliases', d.aliases) order by d.name, d.id)
      from public.destinations d where d.department_id = p_department_id and d.is_approved
    ), '[]'::jsonb),
    'people', coalesce((
      select jsonb_agg(x.person order by x.kind, x.n desc, x.name)
      from (
        select 0 as kind, 0::bigint as n, c.full_name as name,
          jsonb_build_object('name', c.full_name, 'kind', 'child') as person
        from public.child_guardians g join public.children c on c.id = g.child_id
        where g.profile_id = v_me and c.department_id = p_department_id
        union all
        select 1, t.n, p.full_name,
          jsonb_build_object('name', p.full_name, 'kind', 'member', 'drives', not p.does_not_drive)
        from (
          select other_id, count(*) as n from (
            select rc.profile_id as other_id
            from public.requests r join public.request_companions rc on rc.request_id = r.id
            where r.department_id = p_department_id and r.requester_id = v_me and coalesce(r.depart_at, r.return_at) > p_now - interval '60 days'
            union all
            select r.requester_id
            from public.requests r join public.request_companions rc on rc.request_id = r.id
            where r.department_id = p_department_id and rc.profile_id = v_me and coalesce(r.depart_at, r.return_at) > p_now - interval '60 days'
          ) o where other_id <> v_me group by other_id order by count(*) desc, other_id limit 12
        ) t join public.profiles p on p.id = t.other_id
      ) x
    ), '[]'::jsonb),
    'rides', coalesce((
      select jsonb_agg(jsonb_build_object(
          'request_id', r.id,
          'date', to_char(coalesce(r.depart_at, r.return_at) at time zone 'Asia/Jerusalem', 'YYYY-MM-DD'),
          'start', to_char(coalesce(r.depart_at, r.return_at) at time zone 'Asia/Jerusalem', 'HH24:MI'),
          'end', case when r.return_at is null then null else to_char(r.return_at at time zone 'Asia/Jerusalem', 'HH24:MI') end,
          'trip_type', r.trip_type,
          'origin', coalesce(od.name, nullif(trim(r.origin_text), ''), v_home, ''),
          'destination', coalesce(dd.name, nullif(trim(r.destination_text), ''), ''),
          'stops', coalesce((
            select jsonb_agg(jsonb_build_object('leg', s.leg, 'place', coalesce(sd.name, s.place_text)) order by s.leg, s.position)
            from public.request_stops s left join public.destinations sd on sd.id = s.place_id
            where s.request_id = r.id and (s.leg = 'out' or r.return_at is not null)
          ), '[]'::jsonb),
          'people', coalesce((
            select jsonb_agg(n.name order by n.ord, n.name) from (
              select 0 as ord, rp.full_name as name from public.profiles rp where rp.id = r.requester_id and r.requester_id <> v_me
              union all
              select 1, cp.full_name from public.request_companions rc join public.profiles cp on cp.id = rc.profile_id
              where rc.request_id = r.id and rc.profile_id <> v_me
              union all
              select 2, ch.full_name from public.request_children rch join public.children ch on ch.id = rch.child_id
              where rch.request_id = r.id
            ) n
          ), '[]'::jsonb)
        ) order by coalesce(r.depart_at, r.return_at), r.id)
      from public.requests r
      left join public.destinations od on od.id = r.origin_id
      left join public.destinations dd on dd.id = r.destination_id
      where r.department_id = p_department_id
        and (r.requester_id = v_me or r.filed_by = v_me
          or exists (select 1 from public.request_companions rc where rc.request_id = r.id and rc.profile_id = v_me))
        and r.status not in ('withdrawn', 'cancelled', 'denied', 'draft')
        and r.plan_b_parent_id is null
        and coalesce(r.return_at, r.depart_at) >= p_now
        and coalesce(r.depart_at, r.return_at) < p_now + interval '15 days'
    ), '[]'::jsonb)
  );
end $$;

revoke all on function public.ask_context(uuid, timestamptz) from public;
grant execute on function public.ask_context(uuid, timestamptz) to authenticated;
