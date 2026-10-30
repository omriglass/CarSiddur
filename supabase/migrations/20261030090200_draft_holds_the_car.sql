-- REQ §13.161 (b), O28-5 part 2 (owner 2026-10-30: "otherwise drafts are irrelevant"): only the draft holds the car.
-- While a shift/origin proposal of a placed request is open (draft, sent, or accepted and waiting to apply), the ride it
-- would change is marked `draft_hold`: its current time no longer holds the car (the overlap constraint and the
-- turnaround check skip it), and the proposal's own car + time does - a ride written over it (time/car change, or a
-- request linked onto it) is refused like any turnaround conflict, except for the proposal's own request.
-- When the proposal closes without being applied (declined, withdrawn, discarded, expired), the ride takes its time
-- back - unless that time was taken meanwhile: then the ride is released, its requests wait again, the member hears
-- they were taken off the ride and the Sadran who made / sent the offer is told why (never a double booking).

alter table public.rides add column draft_hold boolean not null default false;
comment on column public.rides.draft_hold is
  'REQ §13.161 (b): an open shift/origin proposal of a request on this ride holds the car instead; this ride''s own time does not (synced by _sync_draft_hold).';

alter table public.rides drop constraint rides_no_overlap_per_car;
alter table public.rides add constraint rides_no_overlap_per_car exclude using gist
  (car_id with =, tstzrange(starts_at, ends_at, '[)') with &&)
  where (status <> 'cancelled'::public.ride_status and not planning_conflict and not draft_hold) deferrable;

-- The proposal shapes that hold a car for a placed request: a whole-request shift/origin with a car and a time.
create or replace function public._proposal_holds_ride(p public.proposals)
returns boolean
language sql immutable
set search_path to 'public', 'pg_temp'
as $$
  select p.type in ('shift', 'origin') and p.status in ('draft', 'sent', 'accepted') and p.applied_at is null
    and nullif(p.payload ->> 'car_id', '') is not null
    and (nullif(p.payload ->> 'depart_at', '') is not null or nullif(p.payload ->> 'return_at', '') is not null)
    and not (p.payload ? 'leg') and not (p.payload ? 'series_span')
$$;

-- Does [p_from, p_until) on p_car meet an open shift/origin proposal's car + time (plus the turnaround after it) of a
-- request that is not one of p_exempt? (Any open shift/origin with a car - also one for a request with no ride yet.)
create or replace function public._draft_hold_conflict(p_car uuid, p_from timestamptz, p_until timestamptz, p_exempt uuid[])
returns boolean
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select exists (
    select 1 from public.proposals p
    cross join lateral public._proposal_car_holds(p.payload, p.type) h
    where p.type in ('shift', 'origin') and p.status in ('draft', 'sent', 'accepted') and p.applied_at is null
      and nullif(p.payload ->> 'car_id', '') = p_car::text
      and h.car_id = p_car
      and p.request_id <> all(coalesce(p_exempt, '{}'))
      and tstzrange(h.from_at, h.to_at + make_interval(mins => coalesce(public.required_turnaround_minutes(p.department_id, p.week_start), 30)), '[)')
          && tstzrange(p_from, p_until, '[)'))
$$;

create or replace function public.rides_before_write() returns trigger
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare required int; collision boolean; planning boolean; same_window boolean:=false; v_mine uuid[];
begin
  perform pg_advisory_xact_lock(hashtextextended(new.car_id::text,0));
  required:=coalesce(public.required_turnaround_minutes(new.department_id,new.week_start),30);
  planning:=coalesce(current_setting('app.coordinator_planning',true),'')='on'
    and public.can_manage_week(new.department_id,new.week_start);
  if tg_op='UPDATE' then same_window:=new.car_id=old.car_id and new.starts_at=old.starts_at and new.ends_at=old.ends_at and new.status=old.status; end if;
  -- REQ §13.161 (b): the requests on this ride; their own open proposals never block it.
  if tg_op='UPDATE' then select coalesce(array_agg(request_id),'{}') into v_mine from public.ride_requests where ride_id=new.id; end if;
  select coalesce(current_setting('app.day_car_swap',true),'')<>'on' and (exists(select 1 from public.rides r where r.car_id=new.car_id and r.id<>new.id and r.status<>'cancelled'
    and not r.draft_hold
    and tstzrange(r.starts_at,r.ends_at,'[)') && tstzrange(new.starts_at,new.ends_at,'[)'))
    or (planning and tg_op='UPDATE' and not new.draft_hold and public._draft_hold_conflict(new.car_id,new.starts_at,new.ends_at,v_mine))) into collision;
  if planning and collision and not new.draft_hold then
    -- Existing published rides are intercepted by edit_ride and saved as shadows.
    if tg_op='UPDATE' and old.status<>'draft' then raise exception 'published_ride_requires_planning_shadow'; end if;
    new.status:='draft'; new.planning_conflict:=true; new.turnaround_override_minutes:=0;
  elsif new.planning_conflict then
    if new.status<>'draft' or not collision then new.planning_conflict:=false;
    elsif not same_window then raise exception 'not_authorized'; end if;
  end if;
  new.turnaround:=make_interval(mins=>least(required,coalesce(new.turnaround_override_minutes,required)));
  new.blocked_until:=new.ends_at+new.turnaround;
  -- A held ride stands aside (its time is not reserved), so it is checked again only when it takes its time back.
  if new.status<>'cancelled' and not new.draft_hold then
    -- REQ §13.114: only a ride that is new, or whose car / window changed, is checked against maintenance. A
    -- status / flag / driver update on a ride that already sits inside a period (e.g. `flag_rides_in_maintenance`
    -- flagging it when someone extends the period) must not be refused — that made every non-admin who created or
    -- extended a period over a booked ride fail with `ride_conflicts_with_maintenance`.
    if not public.is_admin()
       and (tg_op='INSERT' or new.car_id is distinct from old.car_id or new.starts_at is distinct from old.starts_at
            or new.blocked_until is distinct from old.blocked_until)
       and exists(select 1 from public.car_maintenance_blocks b where b.car_id=new.car_id
      and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(new.starts_at,new.blocked_until,'[)')) then raise exception 'ride_conflicts_with_maintenance'; end if;
    if not new.planning_conflict and coalesce(current_setting('app.day_car_swap',true),'')<>'on' and exists(select 1 from public.rides r where r.car_id=new.car_id and r.id<>new.id and r.status<>'cancelled'
      and not r.draft_hold
      and (not same_window or not r.planning_conflict)
      -- REQ §13.77: consecutive legs of one multi-day series need no turnaround buffer.
      and not (new.series_id is not null and r.series_id = new.series_id)
      and tstzrange(r.starts_at,r.blocked_until,'[)') && tstzrange(new.starts_at,new.blocked_until,'[)')) then
      raise exception 'ride_turnaround_conflict' using errcode='23P01';
    end if;
    -- REQ §13.161 (b): another request's open draft holds this car + time (checked when the window or car moves; a
    -- new ride is checked when a request is linked to it - ride_requests_respect_draft_holds).
    if tg_op='UPDATE' and not new.planning_conflict and coalesce(current_setting('app.day_car_swap',true),'')<>'on'
       and (new.car_id is distinct from old.car_id or new.starts_at is distinct from old.starts_at
            or new.blocked_until is distinct from old.blocked_until or old.status='cancelled' or old.draft_hold)
       and public._draft_hold_conflict(new.car_id,new.starts_at,new.blocked_until,v_mine) then
      raise exception 'ride_held_by_draft' using errcode='23P01';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists rides_before_write on public.rides;
create trigger rides_before_write before insert or update of starts_at, ends_at, car_id, department_id, status,
  turnaround_override_minutes, planning_conflict, draft_hold on public.rides
  for each row execute function public.rides_before_write();

-- A request linked onto a ride that sits over another request's open draft is refused (the ride's own requests exempt,
-- so applying the draft itself - the request placed at its new time - passes).
create or replace function public.ride_requests_respect_draft_holds() returns trigger
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare r public.rides%rowtype; v_mine uuid[];
begin
  select * into r from public.rides where id = new.ride_id;
  if r.id is null or r.status = 'cancelled' or r.draft_hold or r.planning_conflict
     or coalesce(current_setting('app.day_car_swap', true), '') = 'on' then
    return null;
  end if;
  select coalesce(array_agg(request_id), '{}') into v_mine from public.ride_requests where ride_id = r.id;
  if public._draft_hold_conflict(r.car_id, r.starts_at, r.blocked_until, v_mine) then
    raise exception 'ride_held_by_draft' using errcode = '23P01';
  end if;
  return null;
end $$;

create trigger ride_requests_respect_draft_holds after insert on public.ride_requests
  for each row execute function public.ride_requests_respect_draft_holds();

-- Auto-placement's free-car test (auto-approve, freed slots): a held ride's own time is free, a draft's time is not.
create or replace function public._car_free_for_request(p_car uuid, p_request uuid, p_at_origin uuid)
returns boolean
language plpgsql stable security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  q public.requests%rowtype;
  v_ta interval;
  v_end timestamptz;
begin
  select * into q from public.requests where id = p_request;
  if q.id is null or q.depart_at is null then return false; end if;
  v_ta := make_interval(mins => coalesce(public.required_turnaround_minutes(q.department_id, q.week_start), 30));
  v_end := coalesce(q.return_at, q.depart_at + make_interval(mins => greatest(coalesce(public.request_leg_route_minutes(q.id, 'out'), 60), 15)));
  return (p_at_origin is null or public.car_location_at(p_car, q.depart_at) = p_at_origin)
    and not exists (
      select 1 from public.rides r
      where r.car_id = p_car and r.status <> 'cancelled' and not r.planning_conflict and not r.draft_hold
        and not exists (select 1 from public.ride_requests rr where rr.ride_id = r.id and rr.request_id = q.id)
        and tstzrange(r.starts_at, r.blocked_until, '[)') && tstzrange(q.depart_at, v_end + v_ta, '[)'))
    and not public._draft_hold_conflict(p_car, q.depart_at, v_end + v_ta, array[q.id])
    and not exists (
      select 1 from public.car_maintenance_blocks b
      where b.car_id = p_car and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(q.depart_at, v_end, '[)'));
end $$;

-- The Sadran who made / sent the offer is told when a declined change could not give the ride its time back.
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'proposal_answered'::public.notification_event, ch.channel::public.notification_channel, 'declined_slot_taken',
  'השעה של {{firstName}} כבר תפוסה', '{{destination}}, יום {{day}} — ההצעה לא התקבלה, והשעה הקודמת כבר נתפסה בזמן שההצעה הייתה פתוחה. הבקשה חזרה לרשימת ההמתנה.',
  'השעה של {{firstName}} כבר תפוסה', '{{destination}}, יום {{day}} — ההצעה לא התקבלה, והשעה הקודמת כבר נתפסה בזמן שההצעה הייתה פתוחה. הבקשה חזרה לרשימת ההמתנה.'
from (values ('inbox'), ('push')) as ch(channel)
on conflict (event, channel, (coalesce(variant, ''))) do update
  set title = excluded.title, body = excluded.body, default_title = excluded.default_title,
      default_body = excluded.default_body, updated_at = now();

-- Keeps `draft_hold` in step with the request's open proposals; a ride whose hold ends takes its time back, or - when
-- that time was taken meanwhile - is released (requests waiting, member and offer's Sadran told).
create or replace function public._sync_draft_hold(p_request_id uuid)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_prop public.proposals%rowtype; v_ride uuid; r public.rides%rowtype; v_ids uuid[]; v_who record; v_to uuid; v_by text;
  v_prev text := coalesce(current_setting('app.system_status_transition', true), 'off');
begin
  if p_request_id is null then return; end if;
  select * into v_prop from public.proposals p
  where p.request_id = p_request_id and public._proposal_holds_ride(p)
  order by (p.status = 'draft'), p.created_at desc limit 1;
  if v_prop.id is not null
     and (select count(*) from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
          where rr.request_id = p_request_id and rd.status <> 'cancelled') = 1 then
    select rd.id into v_ride from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
    where rr.request_id = p_request_id and rd.status <> 'cancelled';
  end if;
  if v_ride is not null then
    update public.rides set draft_hold = true where id = v_ride and not draft_hold;
  end if;

  -- Rides of this request still held but no longer by an open proposal.
  for r in
    select rd.* from public.rides rd
    where rd.draft_hold and rd.id is distinct from v_ride
      and (rd.status = 'cancelled' or exists (select 1 from public.ride_requests rr where rr.ride_id = rd.id and rr.request_id = p_request_id))
      and not exists (select 1 from public.ride_requests rr join public.proposals p on p.request_id = rr.request_id
                      where rr.ride_id = rd.id and rr.request_id <> p_request_id and public._proposal_holds_ride(p))
    order by rd.id for update
  loop
    if r.status = 'cancelled' then
      update public.rides set draft_hold = false where id = r.id;
      continue;
    end if;
    select coalesce(array_agg(request_id), '{}') into v_ids from public.ride_requests where ride_id = r.id;
    if exists (select 1 from public.rides o where o.car_id = r.car_id and o.id <> r.id and o.status <> 'cancelled'
                 and not o.draft_hold and not o.planning_conflict
                 and not (r.series_id is not null and o.series_id = r.series_id)
                 and tstzrange(o.starts_at, o.blocked_until, '[)') && tstzrange(r.starts_at, r.blocked_until, '[)'))
       or public._draft_hold_conflict(r.car_id, r.starts_at, r.blocked_until, v_ids)
       or exists (select 1 from public.car_maintenance_blocks b where b.car_id = r.car_id
                    and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(r.starts_at, r.blocked_until, '[)')) then
      -- Its time was taken while the change was open: released, never double-booked.
      select p.* into v_prop from public.proposals p where p.request_id = any(v_ids) and p.type in ('shift', 'origin')
      order by p.updated_at desc limit 1;
      select full_name into v_by from public.profiles where id = v_prop.created_by;
      for v_who in select distinct q.id as request_id, q.requester_id from public.requests q where q.id = any(v_ids)
        and q.requester_id is distinct from (select auth.uid()) loop
        perform public.enqueue_notification(v_who.requester_id, 'outcome_changed', r.department_id, r.week_start,
          jsonb_build_object('byName', coalesce(v_by, '')),
          jsonb_build_object('variant', 'unassigned_by_sadran', 'request_id', v_who.request_id, 'ride_id', r.id),
          format('unassigned_by_sadran:%s:%s:%s', r.id, v_who.request_id, clock_timestamp()));
      end loop;
      perform set_config('app.audit_reason', 'draft_slot_taken', true);
      perform set_config('app.system_status_transition', 'on', true);
      update public.rides set status = 'cancelled', cancelled_at = now(), cancel_reason = 'DRAFT_SLOT_TAKEN', draft_hold = false,
        cancelled_by = coalesce((select auth.uid()), v_prop.created_by, r.created_by)
      where id = r.id;
      delete from public.ride_requests where ride_id = r.id;
      update public.requests q set status = 'waitlisted', status_reason = 'DRAFT_SLOT_TAKEN'
      where q.id = any(v_ids) and q.status not in ('cancelled', 'withdrawn', 'external', 'denied')
        and not exists (select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
                        where rr.request_id = q.id and rd.status <> 'cancelled');
      perform set_config('app.system_status_transition', v_prev, true);
      if v_prop.id is not null then
        for v_to in select distinct x from unnest(array[v_prop.created_by, v_prop.sent_by]) x
                    where x is not null and x is distinct from (select auth.uid()) loop
          perform public.enqueue_notification(v_to, 'proposal_answered', v_prop.department_id, v_prop.week_start,
            jsonb_build_object('byName', coalesce(v_by, '')),
            jsonb_build_object('variant', 'declined_slot_taken', 'proposal_id', v_prop.id, 'request_id', v_prop.request_id),
            format('declined_slot_taken:%s:%s', v_prop.id, v_to));
        end loop;
      end if;
      perform public.flag_car_chain_breaks(r.car_id, r.week_start);
    else
      update public.rides set draft_hold = false where id = r.id;
    end if;
  end loop;
end $$;

create or replace function public.proposals_sync_draft_hold() returns trigger
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  perform public._sync_draft_hold(new.request_id);
  return null;
end $$;

-- Deferred: a superseded draft (withdrawn, then the new one inserted) never lets go of the ride in between.
create constraint trigger proposals_sync_draft_hold after insert or update of status, payload, applied_at on public.proposals
  deferrable initially deferred for each row
  when (new.type in ('shift', 'origin'))
  execute function public.proposals_sync_draft_hold();

revoke all on function public._proposal_holds_ride(public.proposals) from public;
revoke all on function public._draft_hold_conflict(uuid, timestamptz, timestamptz, uuid[]) from public;
revoke all on function public._sync_draft_hold(uuid) from public;
revoke all on function public.proposals_sync_draft_hold() from public;
revoke all on function public.ride_requests_respect_draft_holds() from public;

-- Rides already under an open draft when this ships.
do $$
declare v_req uuid;
begin
  for v_req in select distinct p.request_id from public.proposals p where public._proposal_holds_ride(p) loop
    perform public._sync_draft_hold(v_req);
  end loop;
end $$;
