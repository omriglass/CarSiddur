-- REQ item 259 (TODO CG1): "איך עושים…" guides per car. Topic rights (car admin / admin), guide rights
-- (can_manage_car), step normalization, one guide per car and topic, a topic's title on its guides, the missing-guide
-- view (required, active topics; shared, not retired cars), deleting a topic keeps the guides, reads by members only.
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
  car_a uuid := '33000000-0000-0000-0000-000000000001';
  car_resp uuid := '33000000-0000-0000-0000-000000000002';
  car_private uuid := '33000000-0000-0000-0000-000000000003';
  car_b uuid := '33000000-0000-0000-0000-000000000004';
  t_tires uuid; t_airbag uuid; t_opt uuid; t_b uuid;
  g uuid; g2 uuid;
  v text;
begin
  perform pg_temp.as_user(admin_id);
  select id into dept_b from public.create_department('Guides test B', 'guides-test-b', dept);
  insert into public.cars (id, department_id, name, license_plate, type, status, responsible_id, owner_id, model) values
    (car_a, dept, 'CG a', 'CG-0001', 'shared', 'active', null, null, 'Corolla'),
    (car_resp, dept, 'CG resp', 'CG-0002', 'shared', 'active', plain, null, 'Corolla'),
    (car_private, dept, 'CG private', 'CG-0003', 'temporary', 'active', null, plain, null),
    (car_b, dept_b, 'CG b', 'CG-0004', 'shared', 'active', null, null, null);
  perform public.admin_set_car_admin(dept, car_admin, true);

  v := pg_temp.err_of(format('update public.cars set model = %L where id = %L', '   ', car_a));
  assert v like '%cars_model_ck%', format('a blank model is refused, got %s', v);

  -- Topic rights -----------------------------------------------------------------------------------------------
  perform pg_temp.as_user(plain);
  v := pg_temp.err_of(format('select public.upsert_car_guide_topic(%L, null, ''x'', true, true)', dept));
  assert v = 'not_authorized', format('a plain member may not define topics, got %s', v);
  perform pg_temp.as_user(sadran_id);
  v := pg_temp.err_of(format('select public.upsert_car_guide_topic(%L, null, ''x'', true, true)', dept));
  assert v = 'not_authorized', format('the Sadran does not define topics, got %s', v);
  perform pg_temp.as_user(car_admin);
  v := pg_temp.err_of(format('select public.upsert_car_guide_topic(%L, null, ''x'', true, true)', dept_b));
  assert v = 'not_authorized', format('a car admin of A may not define for B, got %s', v);
  v := pg_temp.err_of(format('select public.upsert_car_guide_topic(%L, null, ''  '', true, true)', dept));
  assert v = 'invalid_input', format('empty title, got %s', v);

  t_tires := public.upsert_car_guide_topic(dept, null, 'tires', true, true);
  t_airbag := public.upsert_car_guide_topic(dept, null, 'airbag', true, true);
  t_opt := public.upsert_car_guide_topic(dept, null, 'optional', false, true);
  perform public.move_car_guide_topic(t_opt, -1);
  assert (select array_agg(title order by position, id) from public.car_guide_topics where department_id = dept)
         = array['tires', 'optional', 'airbag'], 'moved up one place';

  -- Missing: required, active topics on shared, not retired cars of the department.
  assert (select count(*) from public.car_guide_missing where car_id = car_a) = 2, 'two required topics missing on car a';
  assert not exists (select 1 from public.car_guide_missing where car_id = car_private), 'a private car is not flagged';
  assert not exists (select 1 from public.car_guide_missing where topic_id = t_opt), 'an optional topic is never missing';

  -- Guide rights -----------------------------------------------------------------------------------------------
  perform pg_temp.as_user(sadran_id);
  v := pg_temp.err_of(format('select public.save_car_guide(%L, null, %L, null, ''["a"]''::jsonb)', car_resp, t_tires));
  assert v = 'not_authorized', format('the Sadran does not manage cars, got %s', v);

  perform pg_temp.as_user(plain);  -- car_resp's responsible person
  v := pg_temp.err_of(format('select public.save_car_guide(%L, null, null, ''own'', ''[]''::jsonb)', car_resp));
  assert v = 'invalid_input', format('no steps, got %s', v);
  v := pg_temp.err_of(format('select public.save_car_guide(%L, null, null, ''own'', ''["  ", {"text": ""}]''::jsonb)', car_resp));
  assert v = 'invalid_input', format('blank steps only, got %s', v);
  v := pg_temp.err_of(format('select public.save_car_guide(%L, null, null, ''  '', ''["a"]''::jsonb)', car_resp));
  assert v = 'invalid_input', format('an own guide needs a title, got %s', v);
  v := pg_temp.err_of(format('select public.save_car_guide(%L, null, null, ''own'', %L::jsonb)', car_resp,
    (select jsonb_agg('s' || i) from generate_series(1, 31) i)));
  assert v = 'invalid_input', format('at most 30 steps, got %s', v);
  v := pg_temp.err_of(format('select public.save_car_guide(%L, null, %L, null, ''["a"]''::jsonb)', car_a, t_tires));
  assert v = 'not_authorized', format('the responsible person of another car may not write car a, got %s', v);

  g := public.save_car_guide(car_resp, null, t_tires, 'ignored title', '[" press the button ", {"text": "hold 3 s"}, " "]'::jsonb);
  assert (select steps from public.car_guides where id = g) = '[{"text": "press the button"}, {"text": "hold 3 s"}]'::jsonb,
    'steps trimmed, objects normalized, blanks dropped';
  assert (select title from public.car_guides where id = g) = 'tires', 'a topic guide carries the topic title';
  assert (select updated_by from public.car_guides where id = g) = plain, 'updated_by';
  -- A second save on the same topic updates the one guide.
  g2 := public.save_car_guide(car_resp, null, t_tires, null, '["one"]'::jsonb);
  assert g2 = g, 'one guide per car and topic';
  assert (select count(*) from public.car_guides where car_id = car_resp) = 1, 'still one guide';
  -- An own extra guide.
  g2 := public.save_car_guide(car_resp, null, null, ' child seat ', '["click"]'::jsonb);
  assert (select title from public.car_guides where id = g2) = 'child seat' and (select topic_id from public.car_guides where id = g2) is null, 'own guide';
  -- A car admin writes on any shared car of the department.
  perform pg_temp.as_user(car_admin);
  g2 := public.save_car_guide(car_a, null, t_tires, null, '["x"]'::jsonb);

  perform pg_temp.as_user(admin_id);
  t_b := public.upsert_car_guide_topic(dept_b, null, 'b topic', true, true);
  perform pg_temp.as_user(car_admin);
  v := pg_temp.err_of(format('select public.save_car_guide(%L, null, %L, null, ''["a"]''::jsonb)', car_a, t_b));
  assert v = 'invalid_input', format('a topic of another department, got %s', v);

  assert (select array_agg(title order by title) from public.car_guide_missing where car_id = car_a) = array['airbag'],
    'car a now misses only the airbag guide';

  -- Renaming a topic renames its guides; deleting it keeps them as the cars' own guides.
  perform public.upsert_car_guide_topic(null, t_tires, 'tire pressure', true, true);
  assert (select count(*) from public.car_guides where topic_id = t_tires and title = 'tire pressure') = 2, 'renamed on both cars';
  perform public.upsert_car_guide_topic(null, t_airbag, 'airbag', true, false);
  assert not exists (select 1 from public.car_guide_missing where topic_id = t_airbag), 'an inactive topic is never missing';
  perform public.delete_car_guide_topic(t_tires);
  assert (select count(*) from public.car_guides where title = 'tire pressure' and topic_id is null) = 2, 'guides kept as own guides';

  raise notice 'car_guides: writes ok';
end $$;

-- Reads: department members only; deleting through the RPC.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000104","role":"authenticated"}', true);
do $$
declare
  dept uuid := '00000000-0000-0000-0000-000000000001';
  car_resp uuid := '33000000-0000-0000-0000-000000000002';
  g uuid;
  v text;
begin
  assert (select count(*) from public.car_guides where car_id = car_resp) = 2, 'a member reads the guides';
  assert not exists (select 1 from public.car_guide_topics where department_id <> dept), 'no other department topics';
  assert not exists (select 1 from public.car_guides where department_id <> dept), 'no other department guides';
  select id into g from public.car_guides where car_id = car_resp and title = 'child seat';
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000102","role":"authenticated"}', true);
  begin
    perform public.delete_car_guide(g);
    v := 'ok';
  exception when others then v := sqlerrm;
  end;
  assert v = 'not_authorized', format('only who manages the car deletes, got %s', v);
  begin
    insert into public.car_guides (department_id, car_id, title, steps) values (dept, car_resp, 'x', '[{"text":"a"}]');
    v := 'ok';
  exception when others then v := sqlerrm;
  end;
  assert v like '%row-level security%' or v like '%permission denied%', format('no direct writes, got %s', v);
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000104","role":"authenticated"}', true);
  perform public.delete_car_guide(g);
  assert not exists (select 1 from public.car_guides where id = g), 'deleted';
  raise notice 'car_guides: ok';
end $$;

reset role;
rollback;
