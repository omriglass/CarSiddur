-- REQ §13.43 / §13.116 (R8B5, R8M1): an ask-to-join on a PRIVATE (temporary) car really reaches its owner, and the driver of
-- a shared ride is told when someone asks to join.
--   * `submit_request` only created the merge draft for the owner ("create + send straight to the owner" was never sent:
--     sent_at stayed null, the owner heard nothing). A deferred constraint trigger sends it once the whole RPC has
--     written the proposal and its parties (so submit_request itself, rewritten by other work, stays untouched). If the
--     send is refused (the ride changed, seats, ...) the draft stays and the Sadran gets the ordinary ask-to-join notice,
--     which is the Sadran's in-app path (it opens the request on the board).
--   * a driver whose shared ride is asked to join gets an informational `join_asked` notice (the Sadran decides).

create or replace function public.proposals_send_ask_to_join() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_req public.requests%rowtype; v_ride uuid;
begin
  if not exists (select 1 from public.proposals p where p.id = new.id and p.status = 'draft') then return null; end if;
  begin
    perform public.send_proposal(new.id, '{}'::public.notification_channel[]);
  exception when others then
    select * into v_req from public.requests where id = new.request_id;
    v_ride := nullif(new.payload ->> 'ride_id', '')::uuid;
    perform public.enqueue_notification(s.profile_id, 'waitlisted_request', new.department_id, new.week_start,
      jsonb_build_object('requestId', new.request_id::text, 'rideLabel', coalesce(public._ask_to_join_ride_label(v_ride), '')),
      jsonb_build_object('request_id', new.request_id, 'variant', 'ask_to_join'),
      format('waitlisted_request:%s', new.request_id))
    from public.sadranim_of(new.department_id, new.week_start) as s(profile_id);
  end;
  return null;
end $$;

revoke all on function public.proposals_send_ask_to_join() from public;
grant execute on function public.proposals_send_ask_to_join() to service_role;

drop trigger if exists proposals_send_ask_to_join on public.proposals;
create constraint trigger proposals_send_ask_to_join after insert on public.proposals
  deferrable initially deferred for each row
  when (new.created_via = 'ask_to_join' and new.reason_he = 'ASK_TO_JOIN_TEMP_CAR')
  execute function public.proposals_send_ask_to_join();

create or replace function public.requests_notify_join_asked() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.rides%rowtype; v_type text; v_joiner text;
begin
  if new.join_ride_id is null then return null; end if;
  if tg_op = 'UPDATE' and old.join_ride_id is not distinct from new.join_ride_id then return null; end if;
  select * into r from public.rides where id = new.join_ride_id;
  if r.id is null or r.driver_id is null or r.driver_id = new.requester_id then return null; end if;
  select c.type into v_type from public.cars c where c.id = r.car_id;
  if v_type = 'temporary' then return null; end if;   -- the owner gets the proposal itself
  select full_name into v_joiner from public.profiles where id = new.requester_id;
  perform public.enqueue_notification(r.driver_id, 'outcome_changed', r.department_id, r.week_start,
    jsonb_build_object('joinerName', coalesce(v_joiner, ''), 'route', coalesce(public.request_route_label(new.id), ''),
      'day', public.day_date_label(r.starts_at)),
    jsonb_build_object('variant', 'join_asked', 'ride_id', r.id),
    format('join_asked:%s:%s', new.id, r.id));
  return null;
end $$;

revoke all on function public.requests_notify_join_asked() from public;
grant execute on function public.requests_notify_join_asked() to service_role;

drop trigger if exists requests_notify_join_asked on public.requests;
create trigger requests_notify_join_asked after insert or update of join_ride_id on public.requests
  for each row when (new.join_ride_id is not null) execute function public.requests_notify_join_asked();

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body) values
  ('outcome_changed', 'inbox', 'join_asked', '{{joinerName}} מבקש/ת להצטרף לנסיעה שלך',
   '{{route}} · {{day}} · הסדרן/ית יחליט/ה ויעדכן/ת אותך — אין צורך לענות',
   '{{joinerName}} מבקש/ת להצטרף לנסיעה שלך', '{{route}} · {{day}} · הסדרן/ית יחליט/ה ויעדכן/ת אותך — אין צורך לענות'),
  ('outcome_changed', 'push', 'join_asked', '{{joinerName}} מבקש/ת להצטרף לנסיעה שלך',
   '{{route}} · {{day}} · הסדרן/ית יחליט/ה ויעדכן/ת אותך — אין צורך לענות',
   '{{joinerName}} מבקש/ת להצטרף לנסיעה שלך', '{{route}} · {{day}} · הסדרן/ית יחליט/ה ויעדכן/ת אותך — אין צורך לענות')
on conflict (event, channel, (coalesce(variant, ''))) do nothing;
