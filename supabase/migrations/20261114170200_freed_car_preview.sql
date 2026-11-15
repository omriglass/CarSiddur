-- FC1 (owner 2026-11-14, REQ item 231): before a member (or the Sadran, from the siddur) confirms a change that frees
-- a shared car, the dialog says what it will cause ("בעקבות השינוי X יקבל/תקבל את הרכב בשעות האלה. תודה!", a
-- discussion, or "X או Y … בהתייעצות עם הסדרן/ית"). freed_car_preview runs the very action the dialog will send —
-- with the caller's own permissions, through the real RPC — fires the commit-time freed-time check, reads the ranking
-- input of every offer it opened (freed_slot_rank_input), and rolls everything back. The browser ranks that input with
-- the same solver module as the edge function (src/solver/freedSlotRun.ts), so the line cannot drift from the outcome.
-- Nothing is written, sent or queued: the action, its notices and its pg_net calls are all inside the rolled-back block.

create or replace function public.freed_car_preview(p_action text, p_args jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_inputs jsonb := '[]'::jsonb;
  v_started timestamptz := clock_timestamp();
begin
  if (select auth.uid()) is null or not public.is_approved() then raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_action not in ('cancel_ride', 'ride_editor_cancel_ride', 'withdraw_request', 'ride_editor_withdraw_request',
                      'edit_ride', 'submit_request', 'sadran_cancel_ride', 'remove_ride_person') then
    raise exception 'freed_preview_unknown_action' using errcode = 'P0001';
  end if;
  begin
    -- the real action, as the caller: it checks its own permissions and versions
    case p_action
      when 'cancel_ride' then
        perform public.cancel_ride((p_args ->> 'p_ride_id')::uuid, p_args ->> 'p_reason', (p_args ->> 'p_expected_version')::int);
      when 'ride_editor_cancel_ride' then
        perform public.ride_editor_cancel_ride((p_args ->> 'p_ride_id')::uuid, p_args ->> 'p_reason', (p_args ->> 'p_expected_version')::int);
      when 'withdraw_request' then
        perform public.withdraw_request((p_args ->> 'p_request_id')::uuid, (p_args ->> 'p_expected_version')::int);
      when 'ride_editor_withdraw_request' then
        perform public.ride_editor_withdraw_request((p_args ->> 'p_request_id')::uuid, (p_args ->> 'p_expected_version')::int);
      when 'edit_ride' then
        perform public.edit_ride(p_args -> 'p_ride', (p_args ->> 'p_expected_version')::int);
      when 'submit_request' then
        perform public.submit_request(p_args -> 'payload');
      when 'sadran_cancel_ride' then
        perform public.sadran_cancel_ride((p_args ->> 'p_ride_id')::uuid, p_args ->> 'p_reason', (p_args ->> 'p_expected_version')::int,
          coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p_args -> 'p_close_request_ids') x), '{}'),
          coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p_args -> 'p_continue_request_ids') x), '{}'));
      when 'remove_ride_person' then
        perform public.remove_ride_person((p_args ->> 'p_ride_id')::uuid, (p_args ->> 'p_expected_version')::int, p_args ->> 'p_key');
    end case;
    -- the commit-time checks (the freed-time offer among them) run now, inside this block
    set constraints all immediate;
    select coalesce(jsonb_agg(public.freed_slot_rank_input(o.id) order by o.starts_at, o.id), '[]'::jsonb) into v_inputs
    from public.freed_slot_offers o where o.created_at = now() and o.status = 'open';
    set constraints all deferred;
    raise exception 'freed_preview_rollback' using errcode = 'P0001';
  exception when others then
    -- the rollback itself, or the action refused (stale version, needs a question first...): nothing to show
    if sqlerrm <> 'freed_preview_rollback' then v_inputs := '[]'::jsonb; end if;
  end;
  return jsonb_build_object('inputs', v_inputs,
    'ms', round(extract(epoch from clock_timestamp() - v_started) * 1000));
end;
$$;

revoke all on function public.freed_car_preview(text, jsonb) from public, anon, authenticated;
grant execute on function public.freed_car_preview(text, jsonb) to authenticated;
