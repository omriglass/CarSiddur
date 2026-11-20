-- REQ item 258 (AI1, "Ask in words"): the admin opts members in, the member may hide it and acknowledges the
-- disclaimer, the turns are the member's own (👎, closing), an admin reads all and marks evaluation cases,
-- and housekeeping deletes conversations after one month.
begin;

do $$
declare
  admin_id uuid := '00000000-0000-0000-0000-000000000101';
  member uuid := '00000000-0000-0000-0000-000000000103';
  other uuid := '00000000-0000-0000-0000-000000000104';
  dept uuid;
  conv uuid; old_conv uuid; turn uuid;
begin
  select department_id into dept from public.department_members where profile_id = member and removed_at is null limit 1;
  assert dept is not null, 'seed: member 103 has a department';

  -- (1) members cannot opt themselves in; nothing to hide or acknowledge without access
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  begin
    perform public.admin_set_ask_access(member, true);
    raise exception 'a member opted themselves in';
  exception when raise_exception then assert sqlerrm = 'not_authorized', sqlerrm; end;
  begin
    perform public.set_my_ask_hidden(true);
    raise exception 'hid without access';
  exception when raise_exception then assert sqlerrm = 'not_authorized', sqlerrm; end;
  begin
    perform public.ack_ask_disclaimer();
    raise exception 'acknowledged without access';
  exception when raise_exception then assert sqlerrm = 'not_authorized', sqlerrm; end;

  -- (2) the admin opts the member in (twice is harmless)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform public.admin_set_ask_access(member, true);
  perform public.admin_set_ask_access(member, true);
  assert (select granted_by from public.ask_access where profile_id = member) = admin_id, 'granted by the admin';

  -- (3) the member hides it and acknowledges the disclaimer (the first acknowledgement is kept)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  perform public.set_my_ask_hidden(true);
  assert (select hidden from public.ask_access where profile_id = member), 'hidden';
  perform public.set_my_ask_hidden(false);
  perform public.ack_ask_disclaimer();
  update public.ask_access set disclaimer_ack_at = '2026-01-01' where profile_id = member;
  perform public.ack_ask_disclaimer();
  assert (select disclaimer_ack_at from public.ask_access where profile_id = member) = '2026-01-01'::timestamptz, 'first ack kept';

  -- (4) a conversation as the edge function writes it (service role), one turn
  insert into public.ask_conversations (profile_id, department_id) values (member, dept) returning id into conv;
  insert into public.ask_turns (conversation_id, profile_id, department_id, position, user_text, prompt_version, model)
    values (conv, member, dept, 1, 'test', 'test-version', 'test-model') returning id into turn;

  perform public.mark_ask_turn(turn, true);
  assert (select thumbs_down from public.ask_turns where id = turn), '👎 recorded';

  -- another member cannot touch it
  perform set_config('request.jwt.claims', jsonb_build_object('sub', other, 'role', 'authenticated')::text, true);
  begin
    perform public.mark_ask_turn(turn, false);
    raise exception 'another member marked the turn';
  exception when raise_exception then assert sqlerrm = 'not_found', sqlerrm; end;
  begin
    perform public.finish_ask_conversation(conv, 'closed');
    raise exception 'another member closed the conversation';
  exception when raise_exception then assert sqlerrm = 'not_found', sqlerrm; end;

  -- (5) closing: to_form keeps it open for "done"; a request not the member's is refused; after done it is ended
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  begin
    perform public.finish_ask_conversation(conv, 'open');
    raise exception 'open accepted as an outcome';
  exception when raise_exception then assert sqlerrm = 'invalid_input', sqlerrm; end;
  perform public.finish_ask_conversation(conv, 'to_form');
  assert (select outcome = 'to_form' and ended_at is null from public.ask_conversations where id = conv), 'to_form';
  if exists (select 1 from public.requests r where r.department_id = dept and not public.request_related(r.id, member)) then
    begin
      perform public.finish_ask_conversation(conv, 'done',
        (select r.id from public.requests r where r.department_id = dept and not public.request_related(r.id, member) limit 1));
      raise exception 'a request the member is not related to was accepted';
    exception when raise_exception then assert sqlerrm = 'not_authorized', sqlerrm; end;
  end if;
  perform public.finish_ask_conversation(conv, 'done', null, '{"destination":"x"}'::jsonb, '{"time":["10:00","10:30"]}'::jsonb);
  assert (select outcome = 'done' and ended_at is not null and diff ? 'time' from public.ask_conversations where id = conv), 'done';
  begin
    perform public.finish_ask_conversation(conv, 'closed');
    raise exception 'an ended conversation was changed';
  exception when raise_exception then assert sqlerrm = 'conversation_ended', sqlerrm; end;

  -- (6) evaluation cases: admin only
  begin
    perform public.set_ask_eval_case(turn, '{"intent":"unclear"}'::jsonb);
    raise exception 'a member marked an evaluation case';
  exception when raise_exception then assert sqlerrm = 'not_authorized', sqlerrm; end;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform public.set_ask_eval_case(turn, '{"intent":"unclear"}'::jsonb);
  assert (select eval_added_by = admin_id and eval_expect ->> 'intent' = 'unclear' from public.ask_turns where id = turn), 'eval case';
  perform public.set_ask_eval_case(turn, null);
  assert (select eval_expect is null and eval_added_at is null from public.ask_turns where id = turn), 'eval case removed';

  -- (7) one month: housekeeping deletes an older conversation and its turns, keeps the recent one
  insert into public.ask_conversations (profile_id, department_id, created_at)
    values (member, dept, now() - interval '32 days') returning id into old_conv;
  insert into public.ask_turns (conversation_id, profile_id, department_id, position, user_text, prompt_version, model)
    values (old_conv, member, dept, 1, 'old', 'v', 'm');
  delete from public.app_settings where key = 'housekeeping_last_run';
  perform set_config('request.jwt.claims', '', true);
  perform public.housekeeping(date_trunc('day', now() at time zone 'Asia/Jerusalem') at time zone 'Asia/Jerusalem' + interval '4 hours');
  assert not exists (select 1 from public.ask_conversations where id = old_conv), 'old conversation deleted';
  assert not exists (select 1 from public.ask_turns where conversation_id = old_conv), 'its turns deleted';
  assert exists (select 1 from public.ask_conversations where id = conv), 'recent conversation kept';

  -- (8) opting out removes the row
  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  perform public.admin_set_ask_access(other, true);
  perform public.admin_set_ask_access(other, false);
  assert not exists (select 1 from public.ask_access where profile_id = other), 'opted out';
end $$;

-- (9) the edge function's turn RPCs: access, the conversation's owner and department, limits, history.
do $$
declare
  member uuid := '00000000-0000-0000-0000-000000000103';
  other uuid := '00000000-0000-0000-0000-000000000104';
  dept uuid; other_dept uuid;
  b jsonb; b2 jsonb; t uuid; i int;
begin
  select department_id into dept from public.department_members where profile_id = member and removed_at is null limit 1;
  select id into other_dept from public.departments where id <> dept limit 1;
  begin
    perform public.ask_begin_turn(other, dept, null);
    raise exception 'a member without access began a turn';
  exception when raise_exception then assert sqlerrm = 'not_authorized', sqlerrm; end;

  b := public.ask_begin_turn(member, dept, null);
  assert (b ->> 'position')::int = 1 and b -> 'previous_draft' = 'null'::jsonb and b -> 'messages' = '[]'::jsonb, format('first turn: %s', b);
  t := public.ask_record_turn((b ->> 'conversation_id')::uuid, 1, jsonb_build_object('user_text', 'to haifa tomorrow',
    'draft', '{"intent":"new_request"}'::jsonb, 'flags', '["kept_previous"]'::jsonb, 'prompt_version', 'v', 'model', 'm', 'latency_ms', 900));
  assert (select flags = '{kept_previous}' and latency_ms = 900 and profile_id = member and department_id = dept
    from public.ask_turns where id = t), 'turn recorded with the conversation''s owner and department';
  b2 := public.ask_begin_turn(member, dept, (b ->> 'conversation_id')::uuid);
  assert (b2 ->> 'position')::int = 2 and b2 -> 'previous_draft' ->> 'intent' = 'new_request'
    and b2 -> 'messages' = '["to haifa tomorrow"]'::jsonb, format('second turn: %s', b2);
  -- a failed turn (no draft) does not hide the last good draft
  perform public.ask_record_turn((b ->> 'conversation_id')::uuid, 2, '{"user_text":"x","error":"quota","prompt_version":"v","model":"m"}'::jsonb);
  assert public.ask_begin_turn(member, dept, (b ->> 'conversation_id')::uuid) -> 'previous_draft' ->> 'intent' = 'new_request', 'last good draft';

  if other_dept is not null then
    begin
      perform public.ask_begin_turn(member, other_dept, (b ->> 'conversation_id')::uuid);
      raise exception 'a conversation continued in another department';
    exception when raise_exception then assert sqlerrm = 'not_found', sqlerrm; end;
  end if;

  for i in 3..12 loop
    perform public.ask_record_turn((b ->> 'conversation_id')::uuid, i, '{"user_text":"x","prompt_version":"v","model":"m"}'::jsonb);
  end loop;
  begin
    perform public.ask_begin_turn(member, dept, (b ->> 'conversation_id')::uuid);
    raise exception 'a 13th turn began';
  exception when raise_exception then assert sqlerrm = 'conversation_too_long', sqlerrm; end;
  -- 60 turns a day per member
  b := public.ask_begin_turn(member, dept, null);
  insert into public.ask_turns (conversation_id, profile_id, department_id, position, user_text, prompt_version, model)
    select (b ->> 'conversation_id')::uuid, member, dept, g, 'x', 'v', 'm' from generate_series(1, 60) g;
  begin
    perform public.ask_begin_turn(member, dept, null);
    raise exception 'the daily limit did not hold';
  exception when raise_exception then assert sqlerrm = 'daily_limit', sqlerrm; end;
  delete from public.ask_conversations where id = (b ->> 'conversation_id')::uuid;

  update public.ask_conversations set outcome = 'closed' where profile_id = member and outcome = 'open';
  begin
    perform public.ask_begin_turn(member, dept, (select id from public.ask_conversations where profile_id = member and outcome = 'closed' limit 1));
    raise exception 'a closed conversation continued';
  exception when raise_exception then assert sqlerrm = 'conversation_ended', sqlerrm; end;

  assert not has_function_privilege('authenticated', 'public.ask_begin_turn(uuid, uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.ask_record_turn(uuid, integer, jsonb)', 'execute'),
    'the turn RPCs are service-role only';
end $$;

-- (10) ask_context: as the member, only with access and in their own department; their own rides, no ids of others,
--      never the note to the Sadran.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000104","role":"authenticated"}', true);
do $$ begin
  begin
    perform public.ask_context((select department_id from public.department_members
      where profile_id = '00000000-0000-0000-0000-000000000104' and removed_at is null limit 1));
    raise exception 'ask_context without access';
  exception when raise_exception then assert sqlerrm = 'not_authorized', sqlerrm; end;
end $$;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}', true);
do $$
declare
  me uuid := '00000000-0000-0000-0000-000000000103';
  dept uuid := (select department_id from public.department_members where profile_id = me and removed_at is null limit 1);
  other_dept uuid := (select d from unnest(array(select id from public.departments)) d
    where not exists (select 1 from public.department_members m where m.profile_id = me and m.department_id = d and m.removed_at is null) limit 1);
  c jsonb;
begin
  c := public.ask_context(dept);
  assert c ? 'home' and jsonb_typeof(c -> 'places') = 'array' and jsonb_typeof(c -> 'people') = 'array', format('shape: %s', c);
  assert jsonb_array_length(c -> 'places') > 0, 'the department''s places';
  assert not exists (
    select 1 from jsonb_array_elements(c -> 'rides') r
    where not exists (select 1 from public.requests q where q.id = (r ->> 'request_id')::uuid
      and (q.requester_id = me or q.filed_by = me or exists (select 1 from public.request_companions rc where rc.request_id = q.id and rc.profile_id = me)))
  ), 'only the member''s own rides';
  assert not exists (select 1 from jsonb_array_elements(c -> 'rides') r where r ? 'notes'), 'no note to the Sadran';
  if other_dept is not null then
    begin
      perform public.ask_context(other_dept);
      raise exception 'ask_context for another department';
    exception when raise_exception then assert sqlerrm = 'not_authorized', sqlerrm; end;
  end if;
end $$;
reset role;

-- RLS: a member reads only their own rows and writes nothing directly; an admin reads all.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000104","role":"authenticated"}', true);
do $$ begin
  assert (select count(*) from public.ask_access) = 0, 'another member read ask_access';
  assert (select count(*) from public.ask_conversations) = 0, 'another member read ask_conversations';
  assert (select count(*) from public.ask_turns) = 0, 'another member read ask_turns';
  begin
    insert into public.ask_access (profile_id) values ('00000000-0000-0000-0000-000000000104');
    raise exception 'a member inserted into ask_access';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}', true);
do $$ begin
  assert (select count(*) from public.ask_access) = 1, 'the member reads their own access row';
  assert (select count(*) from public.ask_turns) >= 1 and not exists (select 1 from public.ask_turns where profile_id <> '00000000-0000-0000-0000-000000000103'), 'the member reads their own turns only';
  begin
    update public.ask_access set hidden = true;
    raise exception 'a member updated ask_access directly';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000101","role":"authenticated"}', true);
do $$ begin
  assert (select count(*) from public.ask_turns) >= 1, 'an admin cannot read ask_turns';
  raise notice 'ask_semantics.sql: all assertions passed';
end $$;
reset role;

rollback;
