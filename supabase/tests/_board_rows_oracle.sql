-- PF1 oracle (docs/PF1_PLAN_2026-11.md §3 A2). Not a suite of its own: scripts/test-db.mjs runs it at the end of
-- every SQL suite, inside the suite's transaction, just before its rollback — so every suite's data is coverage.
--
-- For every department week that has rides, and for the service caller plus up to six people of the department
-- (Sadranim first) and one outsider: the rows `board_rows(ids)` returns must equal `v_board_rides` under that
-- viewer's RLS, column for column. Arrays whose order the view leaves open on equal timestamps (suites write
-- everything in one transaction, so `created_at` ties everywhere) are compared as sets.
reset role;
select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true);
create function pg_temp._oracle_norm(j jsonb) returns jsonb language sql immutable as $f$
  select j || jsonb_build_object(
    'passengers', (select coalesce(jsonb_agg(e order by e::text), '[]'::jsonb) from jsonb_array_elements(j -> 'passengers') e),
    -- `served`: the view orders by role and requester name only (one request on a ride with two legs ties); the order
    -- of (role, requester) is still compared, the rows themselves as a set
    'served', (select coalesce(jsonb_agg(e order by e::text), '[]'::jsonb) from jsonb_array_elements(j -> 'served') e),
    'served_order', (select coalesce(jsonb_agg(jsonb_build_array(e -> 'role', e -> 'requester') order by o), '[]'::jsonb)
                       from jsonb_array_elements(j -> 'served') with ordinality x(e, o)))
$f$;
grant execute on function pg_temp._oracle_norm(jsonb) to authenticated;
do $oracle$
declare
  w record; v record; d record;
  v_all uuid[]; v_bad int := 0; v_checked int := 0; v_viewers uuid[];
begin
  for w in select r.department_id, r.week_start, array_agg(r.id) as ids
             from public.rides r group by 1, 2
  loop
    select array_agg(x.id) into v_viewers from (
      (select p.id from public.department_members dm join public.profiles p on p.id = dm.profile_id
        where dm.department_id = w.department_id and dm.removed_at is null
        order by (dm.role = 'sadran') desc, p.is_admin desc, p.id limit 6)
      union all
      (select p.id from public.profiles p
        where not exists (select 1 from public.department_members dm
                           where dm.department_id = w.department_id and dm.profile_id = p.id and dm.removed_at is null)
        order by p.is_admin, p.id limit 1)
      union all select null::uuid) x;

    for v in select unnest(v_viewers) as id loop
      if v.id is null then
        perform set_config('request.jwt.claims', '', true);
        perform set_config('role', 'postgres', true);
      else
        perform set_config('request.jwt.claims', json_build_object('sub', v.id, 'role', 'authenticated')::text, true);
        perform set_config('role', 'authenticated', true);
      end if;

      for d in
        with norm as (
          select 'view' as src, x.id, pg_temp._oracle_norm(to_jsonb(x)) as j
            from public.v_board_rides x
           where x.department_id = w.department_id and x.week_start = w.week_start
             and (v.id is null or public.member_of(w.department_id) or public.is_admin())
          union all
          select 'builder', b.id, pg_temp._oracle_norm(to_jsonb(b)) from public.board_rows(w.ids) b
        )
        select coalesce(a.id, b.id) as id,
               (select string_agg(k, ', ') from jsonb_object_keys(coalesce(a.j, b.j)) k
                 where (a.j -> k) is distinct from (b.j -> k)) as cols,
               a.j is null as missing_in_view, b.j is null as missing_in_builder
          from (select * from norm where src = 'view') a
          full join (select * from norm where src = 'builder') b on b.id = a.id
         where a.j is distinct from b.j
      loop
        v_bad := v_bad + 1;
        raise warning 'board_rows oracle: ride % viewer % dept % week %: % (missing in view %, in builder %)',
          d.id, coalesce(v.id::text, 'service'), w.department_id, w.week_start, d.cols, d.missing_in_view, d.missing_in_builder;
      end loop;
      v_checked := v_checked + 1;
    end loop;
    perform set_config('role', 'postgres', true);
    perform set_config('request.jwt.claims', '', true);
  end loop;
  if v_bad > 0 then raise exception 'board_rows oracle: % row(s) differ from v_board_rides', v_bad; end if;
  raise notice 'board_rows oracle: % viewer-week(s) identical to v_board_rides', v_checked;
end $oracle$;
