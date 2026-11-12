-- PF1 stage B2 (docs/PF1_PLAN_2026-11.md §4): one call for several merge previews. The merge popup asks about every
-- leg it offers and the board about every open merge; each was its own request, in parallel, each on its own API
-- connection. `merge_previews(specs)` answers them in order on one connection. Nothing is stored — the board still
-- asks the server after every change.
--
-- Each item goes through `merge_preview` itself (same authorization, same check), so an item's refusal is that
-- item's `error` (`code` = SQLSTATE, `message`, `details`, `hint` — the fields PostgREST gives for a failed call)
-- and never fails its neighbours.
create or replace function public.merge_previews(p_specs jsonb) returns jsonb
language plpgsql security definer set search_path to 'public','pg_temp' as $$
declare
  s jsonb;
  v_out jsonb := '[]'::jsonb;
  v_state text; v_msg text; v_detail text; v_hint text;
begin
  if not public.is_approved() then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  if p_specs is null or jsonb_typeof(p_specs) <> 'array' or jsonb_array_length(p_specs) > 60 then
    raise exception 'invalid_input' using errcode = 'P0001';
  end if;
  for s in select e.value from jsonb_array_elements(p_specs) with ordinality e(value, n) order by e.n loop
    begin
      v_out := v_out || jsonb_build_array(jsonb_build_object('preview',
        public.merge_preview((s ->> 'ride_id')::uuid, (s ->> 'request_id')::uuid,
                             coalesce(s ->> 'leg', 'both')::public.ride_leg)));
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text,
                              v_detail = pg_exception_detail, v_hint = pg_exception_hint;
      v_out := v_out || jsonb_build_array(jsonb_build_object('error', jsonb_build_object(
        'code', v_state, 'message', v_msg, 'details', nullif(v_detail, ''), 'hint', nullif(v_hint, ''))));
    end;
  end loop;
  return v_out;
end $$;
revoke all on function public.merge_previews(jsonb) from public, anon;
grant execute on function public.merge_previews(jsonb) to authenticated, service_role;
