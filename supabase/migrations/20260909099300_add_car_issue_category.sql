-- Car care portal: categorized issue reports go through `report_car_issue()` only (the
-- existing direct `car_issues_insert` policy predates categories and has no current caller
-- in `src/` — grep confirms only `fetchCarIssues`/`resolveCarIssue` touch this table today).
-- Responsible person + admins can read a car's issue history even outside their own
-- department membership. REQ §6 (car care); DATA_MODEL.md §3.2, §4.3.

alter table public.car_issues add column category public.car_issue_category;

drop policy "car_issues_insert" on public.car_issues;

create policy "car_issues_select_responsible" on public.car_issues for select to authenticated
  using (public.is_car_responsible(car_id));

-- REQ §6 car care: any approved member of the car's department can report an issue with
-- a category, free-text description and optional photo; notifies the car's responsible
-- person, else the department admins.
create or replace function public.report_car_issue(
  _car_id uuid,
  _category public.car_issue_category,
  _description text,
  _photo_path text default null
) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_dept uuid;
  v_car_name text;
  v_by_name text;
  v_issue_id uuid;
  v_recipient uuid;
begin
  select department_id, name into v_dept, v_car_name from public.cars where id = _car_id;
  if v_dept is null then
    raise exception 'car_not_found' using errcode = 'P0001';
  end if;
  if not public.member_of(v_dept) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if length(trim(coalesce(_description, ''))) = 0 then
    raise exception 'description_required' using errcode = 'P0001';
  end if;

  insert into public.car_issues (car_id, reported_by, description, category, photo_path)
  values (_car_id, (select auth.uid()), _description, _category, _photo_path)
  returning id into v_issue_id;

  select full_name into v_by_name from public.profiles where id = (select auth.uid());

  for v_recipient in select * from public.car_care_recipients(_car_id) loop
    perform public.enqueue_notification(v_recipient, 'car_care', v_dept, null,
      jsonb_build_object('carName', v_car_name, 'byName', coalesce(v_by_name, ''),
        'description', left(_description, 100)),
      jsonb_build_object('variant', 'issue_' || _category::text, 'car_id', _car_id, 'issue_id', v_issue_id),
      format('car_care:issue:%s:%s', v_issue_id, v_recipient));
  end loop;

  return v_issue_id;
end;
$$;

revoke execute on function public.report_car_issue(uuid, public.car_issue_category, text, text) from public, anon;
grant execute on function public.report_car_issue(uuid, public.car_issue_category, text, text) to authenticated;
