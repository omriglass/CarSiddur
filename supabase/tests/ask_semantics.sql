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
  assert (select count(*) from public.ask_turns) = 1, 'the member reads their own turns';
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
