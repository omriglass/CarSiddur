-- `week_parts(dept, week, parts)` (PF1 DC2b, 20261112233000): one call for the week data a screen reads.
-- That each part equals the API call it replaced is held by scripts/qa/week-parts-oracle.mjs (through PostgREST, as
-- signed-in users: `npm run db:test` with QA_API=1). This suite holds what SQL alone can see:
--   1. the `requests` part names every column a browser may read (a new column must be added there too);
--   2. every part answers for a Sadran, an unknown part is ignored, counts match the direct reads;
--   3. a part fails alone: someone outside the department gets `not_authorized` for the waiting-list parts
--      and plain (empty) answers for the rest - as the separate calls did;
--   4. SECURITY INVOKER, callable by `authenticated`, not by `anon`.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  sadran uuid := '00000000-0000-0000-0000-000000000102';
  wk date;
  src text;
  missing text;
  parts text[] := array['week','rides','requests','proposals','freedOffers','heldNotices','carLocations',
                        'waitlistGroups','waitlistHolds','siddurWaitlist','rideChanges'];
  res jsonb;
  part text;
  n_rides int; n_requests int;
begin
  -- 1. columns
  select p.prosrc into src from pg_proc p where p.oid = 'public.week_parts(uuid, date, text[])'::regprocedure;
  select string_agg(c.column_name, ', ') into missing
    from information_schema.column_privileges c
   where c.table_schema = 'public' and c.table_name = 'requests' and c.grantee = 'authenticated' and c.privilege_type = 'SELECT'
     and src !~ ('q\.' || c.column_name || '\M');
  if missing is not null then
    raise exception 'week_parts: the requests part does not name readable column(s): %', missing;
  end if;

  -- 4. invoker, grants
  if (select p.prosecdef from pg_proc p where p.oid = 'public.week_parts(uuid, date, text[])'::regprocedure) then
    raise exception 'week_parts must be SECURITY INVOKER (it relies on the caller''s RLS)';
  end if;
  if has_function_privilege('anon', 'public.week_parts(uuid, date, text[])', 'execute') then
    raise exception 'anon may not call week_parts';
  end if;
  if not has_function_privilege('authenticated', 'public.week_parts(uuid, date, text[])', 'execute') then
    raise exception 'authenticated must be able to call week_parts';
  end if;

  -- 2. a Sadran, on the department's week with the most requests
  select w.week_start into wk from public.weeks w
   where w.department_id = dept
   order by (select count(*) from public.requests q where q.department_id = dept and q.week_start = w.week_start) desc, w.week_start
   limit 1;
  if wk is null then raise exception 'fixture: the seed department has no week'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', sadran, 'role', 'authenticated')::text, true);
  set local role authenticated;
  res := public.week_parts(dept, wk, parts || array['no_such_part']);
  select count(*) into n_rides from public.week_board_rides(dept, wk);
  select count(*) into n_requests from public.requests q where q.department_id = dept and q.week_start = wk;
  reset role;

  if res ? 'no_such_part' then raise exception 'an unknown part must be ignored: %', res -> 'no_such_part'; end if;
  foreach part in array parts loop
    if not (res -> part) ? 'data' then
      raise exception 'part % did not answer for the Sadran: %', part, res -> part;
    end if;
  end loop;
  if jsonb_typeof(res #> '{week,data}') <> 'object' or (res #>> '{week,data,week_start}')::date <> wk then
    raise exception 'week part: %', res -> 'week';
  end if;
  if jsonb_array_length(res #> '{rides,data}') <> n_rides then
    raise exception 'rides part: % rows, week_board_rides %', jsonb_array_length(res #> '{rides,data}'), n_rides;
  end if;
  if jsonb_array_length(res #> '{requests,data}') <> n_requests then
    raise exception 'requests part: % rows, requests %', jsonb_array_length(res #> '{requests,data}'), n_requests;
  end if;
  if exists (select 1 from jsonb_array_elements(res #> '{requests,data}') e where e ? 'notes') then
    raise exception 'the requests part must not carry notes (REQ 13.153)';
  end if;
  if public.week_parts(dept, wk, null) <> '{}'::jsonb or public.week_parts(dept, wk, '{}') <> '{}'::jsonb then
    raise exception 'no parts asked: expected {}';
  end if;

  -- 3. someone outside the department (no profile at all)
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  set local role authenticated;
  res := public.week_parts(dept, wk, parts);
  reset role;
  if (res #>> '{waitlistHolds,error,code}') is distinct from '42501' or (res #>> '{waitlistHolds,error,message}') is distinct from 'not_authorized' then
    raise exception 'outsider: waitlistHolds should fail alone with not_authorized: %', res -> 'waitlistHolds';
  end if;
  if (res #>> '{siddurWaitlist,error,code}') is distinct from '42501' then
    raise exception 'outsider: siddurWaitlist should fail alone: %', res -> 'siddurWaitlist';
  end if;
  if res #> '{rides,data}' <> '[]'::jsonb or res #> '{requests,data}' <> '[]'::jsonb or res #> '{proposals,data}' <> '[]'::jsonb then
    raise exception 'outsider: the row parts should answer empty, not fail: % % %', res -> 'rides', res -> 'requests', res -> 'proposals';
  end if;
end;
$$;

rollback;
