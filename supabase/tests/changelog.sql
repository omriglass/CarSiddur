-- REQ §13.139 (b): deliver_changelog() puts one "מה חדש" message in the caller's own inbox — once per entry, never a
-- push (no push_outbox row even with a subscribed device); refuses a malformed entry and an anonymous caller.
-- Transactional; rolled back at the end.
begin;
do $$
declare
  member uuid := '00000000-0000-0000-0000-000000000103';
  n_push int; ok boolean; msg text;
begin
  insert into public.push_subscriptions (profile_id, endpoint, p256dh, auth)
    values (member, 'https://push.example/changelog-test', 'k', 'a') on conflict do nothing;
  select count(*) into n_push from public.push_outbox;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', member, 'role', 'authenticated')::text, true);

  ok := public.deliver_changelog('2026-10-19', 'מה חדש', 'שורה');
  assert ok, 'first delivery should add the message';
  assert (select count(*) from public.notifications where recipient_id = member and event = 'changelog'
    and dedupe_key = 'changelog:2026-10-19' and data ->> 'url' = '/changelog') = 1, 'no inbox message';
  assert (select count(*) from public.push_outbox) = n_push, 'a changelog must never be pushed';
  ok := public.deliver_changelog('2026-10-19', 'מה חדש', 'שורה');
  assert not ok, 'the same entry was delivered twice';

  begin perform public.deliver_changelog('Bad id!', 'x', 'y'); raise exception 'accepted a bad id';
  exception when raise_exception then
    get stacked diagnostics msg = message_text;
    assert msg = 'invalid_changelog', format('got %s', msg);
  end;
  perform set_config('request.jwt.claims', '', true);
  begin perform public.deliver_changelog('2026-10-20', 'x', 'y'); raise exception 'anonymous delivery';
  exception when raise_exception then
    get stacked diagnostics msg = message_text;
    assert msg = 'not_authorized', format('got %s', msg);
  end;
  raise notice 'changelog.sql: all assertions passed';
end $$;
rollback;
