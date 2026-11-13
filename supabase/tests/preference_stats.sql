-- AN1 (REQ item 225): a device reports its browser-only preferences; only an admin reads them or the counts.
begin;

do $$
declare
  admin_id uuid := '00000000-0000-0000-0000-000000000101';
  member uuid := '00000000-0000-0000-0000-000000000103';
  v jsonb; n int;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);
  perform public.report_client_preferences('device-aaaa-1111', '{"theme":"blauweiss","experimental":true}'::jsonb, 'v2026.11.13-1');
  perform public.report_client_preferences('device-aaaa-1111', '{"theme":"neutral","experimental":true}'::jsonb, 'v2026.11.13-1');
  assert (select count(*) from public.client_preferences where profile_id = member) = 1, 'one row per device (upsert)';
  begin
    perform public.preference_stats();
    raise exception 'a member read the preference counts';
  exception when raise_exception then
    assert sqlerrm = 'not_authorized', sqlerrm;
  end;
  begin
    perform public.report_client_preferences('short', '{}'::jsonb, null);
    raise exception 'a too short device id was accepted';
  exception when check_violation then null;
  end;

  perform set_config('request.jwt.claims', jsonb_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  v := public.preference_stats();
  assert (v ->> 'members')::int > 0 and (v ->> 'devices')::int >= 1, format('counts: %s', v);
  assert (v -> 'device' -> 'theme' ->> 'neutral')::int >= 1 and (v -> 'device' -> 'experimental' ->> 'true')::int >= 1,
    format('device preferences counted by value: %s', v -> 'device');
  assert v ? 'classicForm' and v ? 'homeWeek' and v ? 'muted' and v ? 'preferredCar', format('database preferences: %s', v);
end $$;

-- RLS: a member does not read the table, an admin does.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000104","role":"authenticated"}', true);
do $$ begin
  assert (select count(*) from public.client_preferences) = 0, 'a member read client_preferences';
end $$;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000101","role":"authenticated"}', true);
do $$ begin
  assert (select count(*) from public.client_preferences) >= 1, 'an admin cannot read client_preferences';
  raise notice 'preference_stats.sql: all assertions passed';
end $$;
reset role;

rollback;
