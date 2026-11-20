-- REQ item 258 (f): "Ask in words" conversations are kept one month (turns go with them, on delete cascade).
-- Full definition from schema-current.sql with one added line.
create or replace function public.housekeeping(p_now timestamptz default now()) returns void
  language plpgsql security definer
  set search_path = public, pg_temp
as $$
declare v_hour int; v_last_prune date;
begin
  perform public.assert_not_direct_rpc('housekeeping');
  perform public.expire_freed_offers(p_now);

  v_hour := extract(hour from (p_now at time zone 'Asia/Jerusalem'));
  -- The marker is stored as a bare JSON string ("2026-10-29"); older rows may hold {"value": ...}. Reading only the
  -- object form made the daily block run on every tick (production 2026-10-29).
  select coalesce(value ->> 'value', value #>> '{}')::date into v_last_prune from public.app_settings where key = 'housekeeping_last_run';

  if v_last_prune is null or v_last_prune < (p_now at time zone 'Asia/Jerusalem')::date then
    perform public.materialize_templates();

    if v_hour >= 3 then
      delete from public.notifications where created_at < p_now - interval '90 days';
      delete from public.push_outbox where status in ('sent', 'dead') and created_at < p_now - interval '30 days';
      delete from public.client_errors where created_at < p_now - interval '90 days';
      delete from public.ask_conversations where created_at < p_now - interval '1 month';
      delete from public.push_subscriptions where last_used_at < p_now - interval '180 days';
      -- token_hash cannot be null (unique not-null column); scramble it instead so old links die (once per row).
      update public.proposal_parties pp set token_hash = 'scrambled:' || gen_random_uuid()::text
      from public.proposals p
      where p.id = pp.proposal_id and pp.token_hash not like 'scrambled:%'
        and coalesce(p.expires_at, p.updated_at) < p_now - interval '30 days'
        and p.status in ('expired', 'withdrawn', 'applied', 'declined');
      update public.proposals set token_hash = 'scrambled:' || gen_random_uuid()::text
      where token_hash not like 'scrambled:%'
        and coalesce(expires_at, updated_at) < p_now - interval '30 days'
        and status in ('expired', 'withdrawn', 'applied', 'declined');
      delete from public.audit_log where at < p_now - interval '1 year'
        and table_name not in ('requests', 'rides', 'proposals', 'policies', 'weeks', 'siddur_versions');
      delete from public.audit_log where at < p_now - interval '3 years';
      delete from public.request_templates where not is_active and updated_at < p_now - interval '1 year';

      insert into public.app_settings (key, value, updated_at)
      values ('housekeeping_last_run', to_jsonb((p_now at time zone 'Asia/Jerusalem')::date::text), p_now)
      on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
    end if;
  end if;
end;
$$;

