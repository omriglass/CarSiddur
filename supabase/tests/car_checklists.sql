-- REQ item 150 (d): handover checklists. Definition rights, submit rights (incl. private cars), the green rule,
-- the snapshot, the prompt on a responsible change, date reminders once, and the access-code write fix.
-- One transaction, rolled back.
begin;

create function pg_temp.err_of(_sql text) returns text
language plpgsql as $$
begin
  execute _sql;
  return 'ok';
exception when others then
  return sqlerrm;
end;
$$;

create function pg_temp.as_user(_id uuid) returns void
language sql as $$ select set_config('request.jwt.claims', jsonb_build_object('sub', _id, 'role', 'authenticated')::text, true) $$;

do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  admin_id uuid := '00000000-0000-0000-0000-000000000101';
  sadran_id uuid := '00000000-0000-0000-0000-000000000102';
  car_admin uuid := '00000000-0000-0000-0000-000000000103';
  plain uuid := '00000000-0000-0000-0000-000000000104';
  dept_b uuid;
  shared_free uuid := '32000000-0000-0000-0000-000000000001';
  shared_resp uuid := '32000000-0000-0000-0000-000000000002';
  private_car uuid := '32000000-0000-0000-0000-000000000003';
  i_yes uuid; i_num uuid; i_date uuid; i_opt uuid;
  r jsonb;
  cl uuid;
  v text;
  n int;
  future_date text := to_char((now() at time zone 'Asia/Jerusalem')::date + 5, 'YYYY-MM-DD');
  today_date text := to_char((now() at time zone 'Asia/Jerusalem')::date, 'YYYY-MM-DD');
  past_date text := to_char((now() at time zone 'Asia/Jerusalem')::date - 1, 'YYYY-MM-DD');
begin
  perform pg_temp.as_user(admin_id);
  select id into dept_b from public.create_department('Checklist test B', 'checklist-test-b', dept);
  insert into public.cars (id, department_id, name, license_plate, type, status, responsible_id, owner_id) values
    (shared_free, dept, 'CL free', 'CL-0001', 'shared', 'active', null, null),
    (shared_resp, dept, 'CL resp', 'CL-0002', 'shared', 'active', plain, null),
    (private_car, dept, 'CL private', 'CL-0003', 'temporary', 'active', null, plain);
  perform public.admin_set_car_admin(dept, car_admin, true);

  -- Definition rights ----------------------------------------------------------------------------------------
  perform pg_temp.as_user(plain);
  v := pg_temp.err_of(format('select public.upsert_car_checklist_item(%L, null, ''x'', ''yes_no'', true, null, true)', dept));
  assert v = 'not_authorized', format('a plain member may not define items, got %s', v);
  perform pg_temp.as_user(sadran_id);
  v := pg_temp.err_of(format('select public.upsert_car_checklist_item(%L, null, ''x'', ''yes_no'', true, null, true)', dept));
  assert v = 'not_authorized', format('the Sadran is not a checklist definer, got %s', v);
  perform pg_temp.as_user(car_admin);
  v := pg_temp.err_of(format('select public.upsert_car_checklist_item(%L, null, ''x'', ''yes_no'', true, null, true)', dept_b));
  assert v = 'not_authorized', format('a car admin of A may not define for B, got %s', v);
  v := pg_temp.err_of(format('select public.upsert_car_checklist_item(%L, null, ''x'', ''yes_no'', true, 3, true)', dept));
  assert v = 'invalid_input', format('reminder days only on date items, got %s', v);
  v := pg_temp.err_of(format('select public.upsert_car_checklist_item(%L, null, ''   '', ''yes_no'', true, null, true)', dept));
  assert v = 'invalid_input', format('empty label, got %s', v);

  -- With no items nothing is asked and nothing can be submitted.
  perform pg_temp.as_user(admin_id);
  update public.cars set responsible_id = car_admin where id = shared_free;
  assert not exists (select 1 from public.car_checklist_prompts where car_id = shared_free), 'no items, no prompt';
  assert (select count(*) from public.notifications where event = 'car_care' and data->>'variant' = 'checklist_requested') = 0, 'no items, no notice';
  update public.cars set responsible_id = null where id = shared_free;
  perform pg_temp.as_user(car_admin);
  v := pg_temp.err_of(format('select public.submit_car_checklist(%L, ''[]''::jsonb)', shared_free));
  assert v = 'checklist_empty', format('empty checklist, got %s', v);

  i_yes := public.upsert_car_checklist_item(dept, null, 'item yes', 'yes_no', true, null, true);
  i_num := public.upsert_car_checklist_item(dept, null, 'item number', 'number', true, null, true);
  i_date := public.upsert_car_checklist_item(dept, null, 'item date', 'date', true, 7, true);
  i_opt := public.upsert_car_checklist_item(dept, null, 'item optional', 'yes_no', false, null, true);
  assert (select array_agg(label order by position, id) from public.car_checklist_items where department_id = dept)
         = array['item yes', 'item number', 'item date', 'item optional'], 'appended in order';
  perform public.move_car_checklist_item(i_opt, -1);
  assert (select array_agg(label order by position, id) from public.car_checklist_items where department_id = dept)
         = array['item yes', 'item number', 'item optional', 'item date'], 'moved up one place';
  perform public.move_car_checklist_item(i_opt, 1);
  perform public.move_car_checklist_item(i_yes, -1);  -- already first: no-op
  assert (select label from public.car_checklist_items where department_id = dept order by position, id limit 1) = 'item yes', 'first stays first';

  -- Submit rights ----------------------------------------------------------------------------------------------
  perform pg_temp.as_user(plain);
  r := jsonb_build_array(jsonb_build_object('item_id', i_yes, 'value', true), jsonb_build_object('item_id', i_num, 'value', 1),
                         jsonb_build_object('item_id', i_date, 'value', future_date));
  v := pg_temp.err_of(format('select public.submit_car_checklist(%L, %L::jsonb)', shared_free, r));
  assert v = 'not_authorized', format('a plain member may not submit for a car they do not manage, got %s', v);
  perform pg_temp.as_user(sadran_id);
  v := pg_temp.err_of(format('select public.submit_car_checklist(%L, %L::jsonb)', shared_free, r));
  assert v = 'not_authorized', format('the Sadran is not a car manager, got %s', v);
  perform pg_temp.as_user(car_admin);
  v := pg_temp.err_of(format('select public.submit_car_checklist(%L, %L::jsonb)', private_car, r));
  assert v = 'not_authorized', format('a car admin may not submit for a private car, got %s', v);

  -- Required items must be answered; wrong shapes are refused.
  v := pg_temp.err_of(format('select public.submit_car_checklist(%L, %L::jsonb)', shared_free,
    jsonb_build_array(jsonb_build_object('item_id', i_yes, 'value', true))));
  assert v = 'checklist_incomplete', format('required items missing, got %s', v);
  v := pg_temp.err_of(format('select public.submit_car_checklist(%L, %L::jsonb)', shared_free,
    jsonb_build_array(jsonb_build_object('item_id', i_yes, 'value', 'yes'), jsonb_build_object('item_id', i_num, 'value', 1), jsonb_build_object('item_id', i_date, 'value', future_date))));
  assert v = 'invalid_answer', format('a string for a yes/no item, got %s', v);
  v := pg_temp.err_of(format('select public.submit_car_checklist(%L, %L::jsonb)', shared_free,
    jsonb_build_array(jsonb_build_object('item_id', i_yes, 'value', true), jsonb_build_object('item_id', i_num, 'value', -3), jsonb_build_object('item_id', i_date, 'value', future_date))));
  assert v = 'invalid_answer', format('a negative number, got %s', v);
  v := pg_temp.err_of(format('select public.submit_car_checklist(%L, %L::jsonb)', shared_free,
    jsonb_build_array(jsonb_build_object('item_id', gen_random_uuid(), 'value', true))));
  assert v = 'invalid_answer', format('an unknown item, got %s', v);

  -- Green: all yes, number filled, date today or later; the optional item may stay blank.
  r := public.submit_car_checklist(shared_free,
    jsonb_build_array(jsonb_build_object('item_id', i_yes, 'value', true), jsonb_build_object('item_id', i_num, 'value', 1234.5),
                      jsonb_build_object('item_id', i_date, 'value', today_date, 'note', 'valid today')));
  assert (r ->> 'green')::boolean, format('green expected, got %s', r);
  cl := (r ->> 'checklist_id')::uuid;
  assert (select outcome from public.car_checklist_answers where checklist_id = cl and item_id = i_opt) = 'skipped', 'optional blank is skipped';
  assert (select note from public.car_checklist_answers where checklist_id = cl and item_id = i_date) = 'valid today', 'note stored';
  assert (select green from public.car_checklist_status where car_id = shared_free), 'status view: green';

  -- Not green: a "no" and a past date, both listed.
  r := public.submit_car_checklist(shared_free,
    jsonb_build_array(jsonb_build_object('item_id', i_yes, 'value', false), jsonb_build_object('item_id', i_num, 'value', 10),
                      jsonb_build_object('item_id', i_date, 'value', past_date), jsonb_build_object('item_id', i_opt, 'value', false)));
  assert not (r ->> 'green')::boolean, 'not green';
  assert jsonb_array_length(r -> 'failures') = 3, format('three failures expected, got %s', r -> 'failures');
  assert (select failures @> jsonb_build_array(jsonb_build_object('item_id', i_date, 'label', 'item date', 'kind', 'date', 'reason', 'expired'))
          from public.car_checklist_status where car_id = shared_free), 'status view lists the failed date item';
  assert (select not green from public.car_checklist_status where car_id = shared_free), 'status view: latest is not green';

  -- Snapshot: renaming/deleting the definition does not rewrite history.
  cl := (r ->> 'checklist_id')::uuid;
  perform public.upsert_car_checklist_item(dept, i_yes, 'item yes RENAMED', 'yes_no', true, null, true);
  perform public.delete_car_checklist_item(i_date);
  assert (select label from public.car_checklist_answers where checklist_id = cl and position = 0) = 'item yes', 'snapshot keeps the old label';
  assert exists (select 1 from public.car_checklist_answers where checklist_id = cl and label = 'item date' and item_id is null and outcome = 'fail_expired'),
    'a deleted item stays in the snapshot';
  i_date := public.upsert_car_checklist_item(dept, null, 'item date', 'date', true, 7, true);

  -- Responsible person (not a car admin) submits for their own car; a private car's responsible person too.
  perform pg_temp.as_user(plain);
  r := public.submit_car_checklist(shared_resp,
    jsonb_build_array(jsonb_build_object('item_id', i_yes, 'value', true), jsonb_build_object('item_id', i_num, 'value', 5),
                      jsonb_build_object('item_id', i_date, 'value', future_date)));
  assert (r ->> 'green')::boolean, 'responsible person submits';
  perform pg_temp.as_user(admin_id);
  update public.cars set responsible_id = plain where id = private_car;
  perform pg_temp.as_user(plain);
  r := public.submit_car_checklist(private_car,
    jsonb_build_array(jsonb_build_object('item_id', i_yes, 'value', true), jsonb_build_object('item_id', i_num, 'value', 5),
                      jsonb_build_object('item_id', i_date, 'value', future_date)));
  assert (r ->> 'green')::boolean, 'a private car''s responsible person may submit';
  assert not exists (select 1 from public.car_checklist_prompts where car_id = private_car), 'no prompt for a private car';

  -- Handover prompt ----------------------------------------------------------------------------------------------
  perform pg_temp.as_user(admin_id);
  update public.cars set responsible_id = car_admin where id = shared_resp;
  assert (select profile_id from public.car_checklist_prompts where car_id = shared_resp and done_at is null) = car_admin, 'prompt for the new responsible';
  assert (select count(*) from public.notifications where event = 'car_care' and data->>'variant' = 'checklist_requested'
          and recipient_id = car_admin and data->>'car_id' = shared_resp::text) = 1, 'exactly one notice to the new responsible';
  assert (select data->>'url' from public.notifications where event = 'car_care' and data->>'variant' = 'checklist_requested' and recipient_id = car_admin limit 1)
         = '/cars/' || shared_resp, 'the notice opens the car page';
  -- someone else completing it does not clear the prompt
  perform pg_temp.as_user(admin_id);
  perform public.submit_car_checklist(shared_resp,
    jsonb_build_array(jsonb_build_object('item_id', i_yes, 'value', true), jsonb_build_object('item_id', i_num, 'value', 5), jsonb_build_object('item_id', i_date, 'value', future_date)));
  assert exists (select 1 from public.car_checklist_prompts where car_id = shared_resp and done_at is null), 'only the prompted person clears it';
  perform pg_temp.as_user(car_admin);
  perform public.submit_car_checklist(shared_resp,
    jsonb_build_array(jsonb_build_object('item_id', i_yes, 'value', true), jsonb_build_object('item_id', i_num, 'value', 5), jsonb_build_object('item_id', i_date, 'value', future_date)));
  assert (select done_at is not null from public.car_checklist_prompts where car_id = shared_resp), 'completed by the prompted person';
  -- prompt visibility
  -- saving the same responsible again asks nothing; clearing the responsible removes the prompt
  perform pg_temp.as_user(admin_id);
  update public.cars set responsible_id = null where id = shared_resp;
  assert not exists (select 1 from public.car_checklist_prompts where car_id = shared_resp), 'no responsible, no prompt';

  -- Date reminders -------------------------------------------------------------------------------------------------
  -- shared_resp's latest checklist (car_admin's) has the date item 5 days ahead, reminder 7 days before.
  update public.cars set responsible_id = plain where id = shared_resp;
  -- shared_free's latest checklist is the not-green one (past date): no reminder for it. Add a second date item.
  perform pg_temp.as_user(admin_id);
  i_opt := public.upsert_car_checklist_item(dept, null, 'item date 2', 'date', false, 30, true);
  perform pg_temp.as_user(plain);
  perform public.submit_car_checklist(shared_resp,
    jsonb_build_array(jsonb_build_object('item_id', i_yes, 'value', true), jsonb_build_object('item_id', i_num, 'value', 5),
                      jsonb_build_object('item_id', i_date, 'value', future_date), jsonb_build_object('item_id', i_opt, 'value', future_date)));
  perform public.send_car_checklist_date_reminders(now());
  assert (select count(*) from public.notifications where event = 'car_care' and data->>'variant' = 'checklist_dates' and recipient_id = plain) = 1,
    'one combined notice to the responsible person for two date items';
  assert (select count(*) from public.notifications where event = 'car_care' and data->>'variant' = 'checklist_dates' and recipient_id = car_admin) = 1,
    'car admins get it too';
  assert (select body_he from public.notifications where event = 'car_care' and data->>'variant' = 'checklist_dates' and recipient_id = plain) like '%item date · CL resp%'
    and (select body_he from public.notifications where event = 'car_care' and data->>'variant' = 'checklist_dates' and recipient_id = plain) like '%item date 2 · CL resp%', 'both items listed';
  perform public.send_car_checklist_date_reminders(now() + interval '15 minutes');
  assert (select count(*) from public.notifications where event = 'car_care' and data->>'variant' = 'checklist_dates') = 2, 'not repeated on the next tick';
  -- a date far ahead is outside its window: no reminder until it enters it
  perform pg_temp.as_user(plain);
  perform public.submit_car_checklist(shared_resp,
    jsonb_build_array(jsonb_build_object('item_id', i_yes, 'value', true), jsonb_build_object('item_id', i_num, 'value', 5),
                      jsonb_build_object('item_id', i_date, 'value', to_char((now() at time zone 'Asia/Jerusalem')::date + 60, 'YYYY-MM-DD'))));
  perform public.send_car_checklist_date_reminders(now() + interval '30 minutes');
  assert (select count(*) from public.notifications where event = 'car_care' and data->>'variant' = 'checklist_dates') = 2, 'outside the window: nothing';
  perform public.send_car_checklist_date_reminders(now() + interval '54 days');
  assert (select count(*) from public.notifications where event = 'car_care' and data->>'variant' = 'checklist_dates') = 4, 'inside the window: once more, per person';
end $$;

-- RLS at the top level --------------------------------------------------------------------------------------------
-- Reads: department members; no direct writes.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000104","role":"authenticated"}', true);
set local role authenticated;
do $$
declare n int;
begin
  assert (select count(*) from public.car_checklist_items) >= 3, 'members read the definition';
  assert (select count(*) from public.car_checklists) >= 3, 'members read the checklists';
  assert (select count(*) from public.car_checklist_prompts where profile_id <> '00000000-0000-0000-0000-000000000104') = 0, 'a plain member sees only their own prompts';
  begin
    insert into public.car_checklist_items (department_id, label, kind) values ('00000000-0000-0000-0000-000000000001', 'x', 'yes_no');
    assert false, 'direct insert of an item';
  exception when others then assert sqlerrm like '%row-level security%' or sqlerrm like '%permission denied%', format('unexpected: %s', sqlerrm); end;
  begin
    update public.car_checklists set green = true;
    get diagnostics n = row_count;
    assert n = 0, 'direct update of a checklist';
  exception when others then assert sqlerrm like '%permission denied%' or sqlerrm like '%row-level security%', format('unexpected: %s', sqlerrm); end;
end $$;
reset role;

-- Access codes (phase-1 follow-up): the car's managers write them; others stay locked out.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000104","role":"authenticated"}', true);
set local role authenticated;
do $$
declare n int;
begin
  -- plain is responsible of shared_resp
  insert into public.car_access_codes (car_id, access_code) values ('32000000-0000-0000-0000-000000000002', '1111')
    on conflict (car_id) do update set access_code = excluded.access_code;
  assert (select access_code from public.car_access_codes where car_id = '32000000-0000-0000-0000-000000000002') = '1111', 'responsible person writes their car''s codes';
  begin
    insert into public.car_access_codes (car_id, access_code) values ('32000000-0000-0000-0000-000000000001', '2222')
      on conflict (car_id) do update set access_code = excluded.access_code;
    assert false, 'plain member wrote codes of a car they do not manage';
  exception when others then assert sqlerrm like '%row-level security%', format('unexpected: %s', sqlerrm); end;
end $$;
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  -- car admin of the department: shared car yes, private car no
  insert into public.car_access_codes (car_id, access_code) values ('32000000-0000-0000-0000-000000000001', '3333')
    on conflict (car_id) do update set access_code = excluded.access_code;
  assert (select access_code from public.car_access_codes where car_id = '32000000-0000-0000-0000-000000000001') = '3333', 'car admin writes a shared car''s codes';
  begin
    insert into public.car_access_codes (car_id, access_code) values ('32000000-0000-0000-0000-000000000003', '4444')
      on conflict (car_id) do update set access_code = excluded.access_code;
    assert false, 'car admin wrote the codes of a private car';
  exception when others then assert sqlerrm like '%row-level security%', format('unexpected: %s', sqlerrm); end;
end $$;
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  update public.car_access_codes set access_code = '5555' where car_id = '32000000-0000-0000-0000-000000000001';
  assert (select access_code from public.car_access_codes where car_id = '32000000-0000-0000-0000-000000000001') = '5555', 'Sadran keeps the right (can_manage_operations)';
end $$;
reset role;

rollback;
