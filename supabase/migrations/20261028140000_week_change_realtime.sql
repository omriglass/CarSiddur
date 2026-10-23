-- REQ item 149 (D2): Realtime broadcast on top of the change counters (20261028130000). Lowers the
-- latency only; the counters and the browser's version check stay correct on their own.
--
-- `_wcs_flush()` (commit time, once per transaction) now also sends one tiny private broadcast per
-- bumped week counter — `realtime.send({"seq": n}, 'changed', topic, private => true)`:
--   week:<department_id>:<week_start>:sadran   on every change of the week (payload: seq)
--   week:<department_id>:<week_start>:public   only when public_seq moved   (payload: public_seq)
-- No row data. The message rows are inserted in the writing transaction, so a rolled-back write
-- sends nothing. `realtime.send` swallows its own errors (a WARNING), and the flush adds its own
-- guard: a broadcast problem never fails the write.
--
-- Joining a private channel is authorised by RLS on realtime.messages (SELECT, role authenticated):
--   public topic -> member_of(department) or is_admin()
--   sadran topic -> can_manage_week(department, week)  (admin, permanent or that week's Sadran)
-- via `realtime_topic_authorized(topic)`, which parses the topic strictly and never raises.
-- No INSERT policy: browsers cannot broadcast on these topics.

create or replace function public._wcs_flush()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_state jsonb := coalesce(nullif(current_setting('app.wcs_state', true), ''), '{}')::jsonb;
  k record;
  v_dept uuid; v_week date; v_pub boolean;
  v_seq bigint; v_public_seq bigint;
  v_topic text;
begin
  perform set_config('app.wcs_state', '', true);
  perform set_config('app.wcs_registered', '', true);
  delete from public.week_change_pending where id = new.id;
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
        perform realtime.send(jsonb_build_object('seq', v_seq), 'changed', v_topic || ':sadran', true);
        if v_pub then
          perform realtime.send(jsonb_build_object('seq', v_public_seq), 'changed', v_topic || ':public', true);
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

revoke all on function public._wcs_flush() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- May the caller join this topic? Strict parse; anything else is false (never an error).
-- ---------------------------------------------------------------------------
create or replace function public.realtime_topic_authorized(p_topic text)
returns boolean
language plpgsql stable security invoker
set search_path = public, pg_temp
as $$
declare
  v_parts text[];
  v_dept uuid; v_week date;
begin
  if p_topic is null or p_topic !~ '^week:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{4}-[0-9]{2}-[0-9]{2}:(public|sadran)$' then
    return false;
  end if;
  v_parts := string_to_array(p_topic, ':');
  v_dept := v_parts[2]::uuid;
  begin
    v_week := v_parts[3]::date;
  exception when others then
    return false;
  end;
  if v_parts[4] = 'sadran' then
    return coalesce(public.can_manage_week(v_dept, v_week), false);
  end if;
  return coalesce(public.member_of(v_dept) or public.is_admin(), false);
end;
$$;

revoke all on function public.realtime_topic_authorized(text) from public, anon;
grant execute on function public.realtime_topic_authorized(text) to authenticated;

-- realtime.messages exists on every Supabase stack (local CLI and hosted); guarded so a plain
-- Postgres replay does not fail.
do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists "week_topics_select" on realtime.messages';
    execute $p$
      create policy "week_topics_select" on realtime.messages for select to authenticated
        using (realtime.messages.extension = 'broadcast'
               and public.realtime_topic_authorized((select realtime.topic())))
    $p$;
  end if;
end $$;
