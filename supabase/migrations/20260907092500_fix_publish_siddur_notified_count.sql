-- Stage 3 hardening fix #1 (DATA_MODEL.md §6.1 item 16): `publish_siddur()`'s final
-- statement, `update public.siddur_versions set notified_count = v_notified where id =
-- v_version_id;`, is unconditionally rejected by `siddur_versions_forbid_mutation`
-- (`20260907091000_siddur_versions.sql`, `forbid_mutation()` always raises `0A000`,
-- unlike `weeks.published_version_id`'s narrower `app.in_publish`-gated trigger) — every
-- call fails and rolls back the whole publish, reproduced against the local stack
-- (UX_FLOWS.md §15 item 1).
--
-- Fix: compute `notified_count` *before* the row is inserted (a single INSERT with the
-- final value, no UPDATE at all) rather than relaxing the immutability trigger for one
-- column. The notification loop only reads `requests`/the previous version's snapshot —
-- neither depends on the new row already existing — so it can run first; `v_version_id`
-- is generated client-side (gen_random_uuid()) so the loop's idempotency keys
-- (`format('%s:%s:%s', v_event, v_version_id, v_req.id)`) are stable and known up front.
-- Full function body reproduced verbatim except this reordering.
create or replace function public.publish_siddur(p_department_id uuid, p_week_start date) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_snapshot jsonb;
  v_version_id uuid := gen_random_uuid();
  v_prev record;
  v_phase public.week_phase;
  v_req record;
  v_notified int := 0;
  v_prev_status text;
  v_event public.notification_event;
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  select * into v_prev from public.siddur_versions
  where department_id = p_department_id and week_start = p_week_start order by version_no desc limit 1;

  select jsonb_build_object(
    'rides', (select coalesce(jsonb_agg(to_jsonb(r)), '[]') from public.rides r
              where r.department_id = p_department_id and r.week_start = p_week_start and r.status <> 'cancelled'),
    'requests', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', q.id, 'requester_id', q.requester_id, 'status', q.status, 'status_reason', q.status_reason)), '[]')
                 from public.requests q where q.department_id = p_department_id and q.week_start = p_week_start),
    'cars', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from public.cars c where c.department_id = p_department_id),
    'blocks', (select coalesce(jsonb_agg(to_jsonb(b)), '[]') from public.car_maintenance_blocks b where b.department_id = p_department_id)
  ) into v_snapshot;

  perform set_config('app.audit_reason', 'publish_siddur', true);

  -- Compute notified_count up front (§ above) — enqueue_notification writes are safe to
  -- run before the siddur_versions row exists since this whole RPC is one transaction:
  -- either everything commits together or everything rolls back together.
  for v_req in
    select id, requester_id, status from public.requests
    where department_id = p_department_id and week_start = p_week_start and status not in ('draft', 'withdrawn')
  loop
    v_prev_status := null;
    if v_prev is not null then
      select elem ->> 'status' into v_prev_status
      from jsonb_array_elements(v_prev.snapshot -> 'requests') elem
      where (elem ->> 'id')::uuid = v_req.id;
    end if;

    if v_prev is null then
      v_event := 'published';
    elsif v_prev_status is distinct from v_req.status::text then
      v_event := 'outcome_changed';
    else
      continue;
    end if;

    perform public.enqueue_notification(v_req.requester_id, v_event, p_department_id, p_week_start,
      '{}'::jsonb, jsonb_build_object('request_id', v_req.id), format('%s:%s:%s', v_event, v_version_id, v_req.id));
    v_notified := v_notified + 1;
  end loop;

  insert into public.siddur_versions (id, department_id, week_start, snapshot, published_by, notified_count)
  values (v_version_id, p_department_id, p_week_start, v_snapshot, (select auth.uid()), v_notified);

  perform set_config('app.in_publish', 'on', true);

  v_phase := case when p_week_start <= public.current_week_start() then 'live' else 'published' end;

  update public.weeks set published_version_id = v_version_id, published_at = now(), phase = v_phase
  where department_id = p_department_id and week_start = p_week_start;

  update public.rides set status = 'confirmed'
  where department_id = p_department_id and week_start = p_week_start and status = 'draft';

  perform set_config('app.in_publish', 'off', true);

  return v_version_id;
end;
$$;
