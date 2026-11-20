-- REQ item 258 (AI1): the browser's writes to ask_access / ask_conversations / ask_turns (20261120110000).

-- Admin: opt a member in or out ("גישה ל״לכתוב במילים״"). Opting out deletes the row (hide switch and disclaimer with it).
create or replace function public.admin_set_ask_access(p_profile_id uuid, p_enabled boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_enabled is null then raise exception 'invalid_input' using errcode = 'P0001'; end if;
  perform 1 from public.profiles where id = p_profile_id;
  if not found then raise exception 'member_not_found' using errcode = 'P0001'; end if;
  if p_enabled then
    insert into public.ask_access (profile_id, granted_by) values (p_profile_id, auth.uid())
    on conflict (profile_id) do nothing;
  else
    delete from public.ask_access where profile_id = p_profile_id;
  end if;
end $$;

-- Member: the profile switch "לכתוב במילים בכפתור +" (hidden = "+" opens the form directly).
create or replace function public.set_my_ask_hidden(p_hidden boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_hidden is null then raise exception 'invalid_input' using errcode = 'P0001'; end if;
  update public.ask_access set hidden = p_hidden where profile_id = auth.uid();
  if not found then raise exception 'not_authorized' using errcode = 'P0001'; end if;
end $$;

-- Member: "הבנתי" on the first-open disclaimer (the first acknowledgement is kept).
create or replace function public.ack_ask_disclaimer()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.ask_access set disclaimer_ack_at = coalesce(disclaimer_ack_at, now()) where profile_id = auth.uid();
  if not found then raise exception 'not_authorized' using errcode = 'P0001'; end if;
end $$;

-- Member: "👎 לא הבין" on one of their own turns (toggle).
create or replace function public.mark_ask_turn(p_turn_id uuid, p_thumbs_down boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_thumbs_down is null then raise exception 'invalid_input' using errcode = 'P0001'; end if;
  update public.ask_turns set thumbs_down = p_thumbs_down where id = p_turn_id and profile_id = auth.uid();
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
end $$;

-- Member: how their conversation ended. to_form may still become done (the prefilled form was sent);
-- a request it names must be one the caller is related to, in the conversation's own department.
create or replace function public.finish_ask_conversation(
  p_conversation_id uuid, p_outcome text, p_request_id uuid default null, p_sent jsonb default null, p_diff jsonb default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_conv public.ask_conversations;
begin
  if p_outcome is null or p_outcome not in ('to_form', 'done', 'cancelled', 'closed') then
    raise exception 'invalid_input' using errcode = 'P0001';
  end if;
  select * into v_conv from public.ask_conversations where id = p_conversation_id and profile_id = auth.uid() for update;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  if v_conv.outcome not in ('open', 'to_form') then raise exception 'conversation_ended' using errcode = 'P0001'; end if;
  if p_request_id is not null and not exists (
    select 1 from public.requests r
    where r.id = p_request_id and r.department_id = v_conv.department_id and public.request_related(r.id, auth.uid())
  ) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  update public.ask_conversations
  set outcome = p_outcome,
      result_request_id = coalesce(p_request_id, result_request_id),
      sent = coalesce(p_sent, sent),
      diff = coalesce(p_diff, diff),
      ended_at = case when p_outcome = 'to_form' then null else now() end
  where id = p_conversation_id;
end $$;

-- Admin: "הוספה לסט הבדיקה" — keep the turn's right answer for the evaluation set (null removes it).
create or replace function public.set_ask_eval_case(p_turn_id uuid, p_expect jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_expect is not null and jsonb_typeof(p_expect) <> 'object' then raise exception 'invalid_input' using errcode = 'P0001'; end if;
  update public.ask_turns
  set eval_expect = p_expect,
      eval_added_by = case when p_expect is null then null else auth.uid() end,
      eval_added_at = case when p_expect is null then null else now() end
  where id = p_turn_id;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
end $$;

revoke all on function public.admin_set_ask_access(uuid, boolean) from public;
revoke all on function public.set_my_ask_hidden(boolean) from public;
revoke all on function public.ack_ask_disclaimer() from public;
revoke all on function public.mark_ask_turn(uuid, boolean) from public;
revoke all on function public.finish_ask_conversation(uuid, text, uuid, jsonb, jsonb) from public;
revoke all on function public.set_ask_eval_case(uuid, jsonb) from public;
grant execute on function public.admin_set_ask_access(uuid, boolean) to authenticated;
grant execute on function public.set_my_ask_hidden(boolean) to authenticated;
grant execute on function public.ack_ask_disclaimer() to authenticated;
grant execute on function public.mark_ask_turn(uuid, boolean) to authenticated;
grant execute on function public.finish_ask_conversation(uuid, text, uuid, jsonb, jsonb) to authenticated;
grant execute on function public.set_ask_eval_case(uuid, jsonb) to authenticated;
