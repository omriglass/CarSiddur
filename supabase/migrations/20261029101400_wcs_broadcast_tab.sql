-- O28-8 (board speed, docs/TODO.md): the week's change broadcast names the page that made the change.
-- Every database API call carries `x-tab-id` (src/lib/tabId.ts); `_wcs_flush()` adds it to the payload as `tab`,
-- so a tab that has just refetched after its own change skips the second reload its own broadcast would cause.
-- No tab header (cron, edge functions, SQL) = `tab: null`, which every screen treats as someone else's change.
-- `create or replace` keeps the existing grants (service_role only; the trigger runs it).

CREATE OR REPLACE FUNCTION "public"."_wcs_flush"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_state jsonb := coalesce(nullif(current_setting('app.wcs_state', true), ''), '{}')::jsonb;
  k record;
  v_dept uuid; v_week date; v_pub boolean;
  v_seq bigint; v_public_seq bigint;
  v_topic text;
  v_tab text;
begin
  perform set_config('app.wcs_state', '', true);
  perform set_config('app.wcs_registered', '', true);
  delete from public.week_change_pending where id = new.id;
  begin
    v_tab := left(nullif(current_setting('request.headers', true), '')::json ->> 'x-tab-id', 64);
  exception when others then
    v_tab := null;
  end;
  for k in select key, value from jsonb_each_text(v_state) order by key loop
    begin
      v_dept := split_part(k.key, '|', 2)::uuid;
      v_pub := k.value = '1';
      if split_part(k.key, '|', 1) = 'w' then
        v_week := split_part(k.key, '|', 3)::date;
        insert into public.week_change_seq as c (department_id, week_start, seq, public_seq)
        values (v_dept, v_week, 1, case when v_pub then 1 else 0 end)
        on conflict (department_id, week_start) do update
          set seq = c.seq + 1,
              public_seq = c.public_seq + case when v_pub then 1 else 0 end,
              updated_at = now()
        returning c.seq, c.public_seq into v_seq, v_public_seq;
        v_topic := 'week:' || v_dept::text || ':' || v_week::text;
        perform realtime.send(jsonb_build_object('seq', v_seq, 'tab', v_tab), 'changed', v_topic || ':sadran', true);
        if v_pub then
          perform realtime.send(jsonb_build_object('seq', v_public_seq, 'tab', v_tab), 'changed', v_topic || ':public', true);
        end if;
      else
        insert into public.department_change_seq as c (department_id, seq)
        values (v_dept, 1)
        on conflict (department_id) do update set seq = c.seq + 1, updated_at = now();
      end if;
    exception when others then
      -- A counter or broadcast must never fail the user's write; the screens' version check catches up.
      raise warning '_wcs_flush: % (%)', sqlerrm, k.key;
    end;
  end loop;
  -- realtime.send sets `realtime.topic` for the rest of the transaction; leave no trace for later statements.
  perform set_config('realtime.topic', '', true);
  return null;
end;
$$;
