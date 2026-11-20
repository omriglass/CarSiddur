-- REQ item 258 (f): the `ask` edge function's writes, service role only (ARCHITECTURE §8: no raw table writes).
-- ask_begin_turn: before the model is called — opens a conversation (or checks the given one is the member's own,
--   in that department, still open), enforces the limits (12 turns a conversation, 60 turns a day per member) and
--   returns the position plus what the next prompt needs (the last draft, the earlier messages).
-- ask_record_turn: after the call — stores the turn (also a failed one, with its error code).

create or replace function public.ask_begin_turn(p_profile_id uuid, p_department_id uuid, p_conversation_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_conv public.ask_conversations;
  v_position int;
begin
  if not exists (select 1 from public.ask_access where profile_id = p_profile_id) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if (select count(*) from public.ask_turns where profile_id = p_profile_id and created_at > now() - interval '1 day') >= 60 then
    raise exception 'daily_limit' using errcode = 'P0001';
  end if;
  if p_conversation_id is null then
    insert into public.ask_conversations (profile_id, department_id) values (p_profile_id, p_department_id) returning * into v_conv;
  else
    select * into v_conv from public.ask_conversations
    where id = p_conversation_id and profile_id = p_profile_id and department_id = p_department_id for update;
    if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
    if v_conv.outcome <> 'open' then raise exception 'conversation_ended' using errcode = 'P0001'; end if;
  end if;
  select coalesce(max(position), 0) + 1 into v_position from public.ask_turns where conversation_id = v_conv.id;
  if v_position > 12 then raise exception 'conversation_too_long' using errcode = 'P0001'; end if;
  return jsonb_build_object(
    'conversation_id', v_conv.id,
    'position', v_position,
    'previous_draft', (select t.draft from public.ask_turns t
      where t.conversation_id = v_conv.id and t.draft is not null order by t.position desc limit 1),
    'messages', coalesce((select jsonb_agg(t.user_text order by t.position) from public.ask_turns t
      where t.conversation_id = v_conv.id), '[]'::jsonb)
  );
end $$;

create or replace function public.ask_record_turn(p_conversation_id uuid, p_position integer, p_turn jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_conv public.ask_conversations;
  v_id uuid;
begin
  select * into v_conv from public.ask_conversations where id = p_conversation_id;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  insert into public.ask_turns (conversation_id, profile_id, department_id, position, user_text, draft_in, raw_answer, draft,
    flags, error, prompt_version, model, latency_ms)
  values (v_conv.id, v_conv.profile_id, v_conv.department_id, p_position, p_turn ->> 'user_text',
    p_turn -> 'draft_in', p_turn -> 'raw_answer', p_turn -> 'draft',
    coalesce(array(select jsonb_array_elements_text(coalesce(p_turn -> 'flags', '[]'::jsonb))), '{}'),
    p_turn ->> 'error', coalesce(p_turn ->> 'prompt_version', ''), coalesce(p_turn ->> 'model', ''),
    nullif(p_turn ->> 'latency_ms', '')::int)
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.ask_begin_turn(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.ask_record_turn(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.ask_begin_turn(uuid, uuid, uuid) to service_role;
grant execute on function public.ask_record_turn(uuid, integer, jsonb) to service_role;
