-- O28-1 (owner 2026-10-28): withdrawing a proposal keeps its tokens (20261029102000), so housekeeping's 30-day
-- scramble is now what ends an old link. It covers:
--   * withdrawn proposals too (they often have no `expires_at`: the age is counted from `updated_at`, i.e. when the
--     proposal ended);
--   * the parties' tokens (`proposal_parties.token_hash`), not only the proposal's own;
--   * each row once: a scrambled hash is written as 'scrambled:<uuid>' (never a sha256 hex, so no link can match it)
--     and skipped afterwards, instead of rewriting (and auditing) every old proposal every night.
-- Full definition from schema-current.sql plus the scramble change.

create or replace function public.housekeeping("p_now" timestamp with time zone DEFAULT "now"()) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_hour int; v_last_prune date;
begin
  perform public.assert_not_direct_rpc('housekeeping');
  perform public.expire_freed_offers(p_now);

  v_hour := extract(hour from (p_now at time zone 'Asia/Jerusalem'));
  select (value ->> 'value')::date into v_last_prune from public.app_settings where key = 'housekeeping_last_run';

  if v_last_prune is null or v_last_prune < (p_now at time zone 'Asia/Jerusalem')::date then
    perform public.materialize_templates();

    if v_hour >= 3 then
      delete from public.notifications where created_at < p_now - interval '90 days';
      delete from public.push_outbox where status in ('sent', 'dead') and created_at < p_now - interval '30 days';
      delete from public.client_errors where created_at < p_now - interval '90 days';
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
