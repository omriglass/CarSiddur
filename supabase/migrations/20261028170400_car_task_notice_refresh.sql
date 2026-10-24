-- REQ item 150 (b): a task added or withdrawn after a person was notified replaces their still-unread inbox entry
-- (the "merge if unread" pattern of 20261028092600): a fresh notification is enqueued, its push is dropped, the old
-- unread one is deleted. The push therefore goes out once per (ride, person). notifications.title/body are locked
-- against updates, hence delete + insert.
create or replace function public._refresh_car_task_notices(p_car_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  rec record;
  v_tasks text;
  v_notif uuid;
begin
  for rec in
    select n.ride_id, n.profile_id, n.notification_id, r.department_id
    from public.car_task_notices n
    join public.rides r on r.id = n.ride_id
    join public.notifications nt on nt.id = n.notification_id and nt.read_at is null
    where r.car_id = p_car_id and r.ends_at + interval '15 minutes' > now()
  loop
    v_tasks := public._car_task_notice_tasks(rec.ride_id);
    continue when v_tasks = '';
    v_notif := public.enqueue_notification(rec.profile_id, 'car_task', rec.department_id, null,
      jsonb_build_object('tasks', v_tasks),
      jsonb_build_object('ride_id', rec.ride_id, 'url', '/my'),
      format('car_task:%s:%s:%s', rec.ride_id, rec.profile_id, gen_random_uuid()));
    continue when v_notif is null;
    delete from public.push_outbox where notification_id = v_notif;
    delete from public.notifications where id = rec.notification_id;
    update public.car_task_notices set notification_id = v_notif
      where ride_id = rec.ride_id and profile_id = rec.profile_id;
  end loop;
end $$;
