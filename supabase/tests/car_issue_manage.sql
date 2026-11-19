-- CR2 (REQ item 257 b): update_car_issue — the car's responsible person (a plain member) marks an issue taken care of
-- and edits its wording; a member who is not the car's manager may not resolve it; the reporter may reword their own
-- open issue; nothing else on the row moves; no notification is sent.
begin;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  responsible uuid := '00000000-0000-0000-0000-000000000103';
  reporter uuid := '00000000-0000-0000-0000-000000000104';
  car uuid := '30000000-0000-0000-0000-0000000000c2';
  issue uuid;
  v text;
  notices_before int;
begin
  insert into public.cars (id, department_id, name, license_plate, type, status, responsible_id)
  values (car, dept, 'CR2 car', 'CR2-TEST-01', 'shared', 'active', responsible);
  update public.department_members set is_car_admin = false where profile_id in (responsible, reporter);

  perform set_config('request.jwt.claims', jsonb_build_object('sub', reporter, 'role', 'authenticated')::text, true);
  issue := public.report_car_issue(car, 'mechanical'::public.car_issue_category, 'נורית שמן', null);
  select count(*) into notices_before from public.notifications;

  -- the reporter: may reword their own open issue, may not resolve it
  perform public.update_car_issue(issue, 'edit', '  נורית שמן דולקת  ');
  assert (select description from public.car_issues where id = issue) = 'נורית שמן דולקת', 'the reporter rewords their open issue (trimmed)';
  begin
    perform public.update_car_issue(issue, 'resolve');
    raise exception 'expected not_authorized';
  exception when others then
    assert sqlerrm = 'not_authorized', format('a non-manager may not resolve, got %s', sqlerrm);
  end;

  -- the responsible person (a plain member): rewords and resolves
  perform set_config('request.jwt.claims', jsonb_build_object('sub', responsible, 'role', 'authenticated')::text, true);
  begin
    perform public.update_car_issue(issue, 'edit', '   ');
    raise exception 'expected invalid_input';
  exception when others then
    assert sqlerrm = 'invalid_input', format('empty wording refused, got %s', sqlerrm);
  end;
  perform public.update_car_issue(issue, 'edit', 'נורית שמן — נבדק במוסך');
  perform public.update_car_issue(issue, 'resolve');
  assert (select status = 'resolved' and resolved_by = responsible and resolved_at is not null and description = 'נורית שמן — נבדק במוסך'
            and reported_by = reporter and category = 'mechanical' and not is_unsafe
          from public.car_issues where id = issue), 'resolved by the responsible person, nothing else moved';
  perform public.update_car_issue(issue, 'resolve'); -- already resolved: no-op
  assert (select count(*) from public.notifications) = notices_before, 'no notification';

  -- the bypass is single-use: a direct status change by the same member is still refused
  perform set_config('request.jwt.claims', jsonb_build_object('sub', '00000000-0000-0000-0000-000000000101', 'role', 'authenticated')::text, true);
  update public.car_issues set status = 'open', resolved_by = null, resolved_at = null where id = issue; -- as the admin, to reopen
  perform set_config('request.jwt.claims', jsonb_build_object('sub', responsible, 'role', 'authenticated')::text, true);
  begin
    perform set_config('app.car_issue_manage', '', true);
    execute 'set local role authenticated';
    update public.car_issues set status = 'resolved', resolved_by = responsible, resolved_at = now() where id = issue;
    execute 'reset role';
    assert (select status = 'open' from public.car_issues where id = issue), 'a direct update by the responsible person changes nothing';
  exception when others then
    execute 'reset role';
    assert sqlerrm in ('car_issue_resolution_locked'), format('direct resolve refused, got %s', sqlerrm);
  end;

  -- unknown action
  begin
    perform public.update_car_issue(issue, 'delete');
    raise exception 'expected invalid_input';
  exception when others then
    assert sqlerrm = 'invalid_input', format('unknown action, got %s', sqlerrm);
  end;
  raise notice 'car_issue_manage.sql: all assertions passed';
end $$;

rollback;
