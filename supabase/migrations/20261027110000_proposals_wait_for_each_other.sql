-- REQ §13.138 (f): proposals that depend on each other wait for each other. When a proposal (B) uses room on a car that
-- only another pending proposal (A) frees — A's request is on a ride in B's slot (turnaround included) — B's acceptance
-- (or "כן, כבר סיכמנו") is kept: B stays `accepted` with `waiting_for = {A}` and is applied as soon as A applies. If A is
-- declined, withdrawn or expires, B is withdrawn (`withdrawn_dependency`) and B's people and the Sadranim are told why.
-- Proposals that wait for each other (two rides swapping places) are applied together once all are accepted, with the
-- car-overlap constraint deferred to the end.

alter table public.proposals add column waiting_for uuid[] not null default '{}'::uuid[];

comment on column public.proposals.waiting_for is
  'REQ §13.138 (f): an accepted proposal that cannot apply until these pending proposals apply (empty = not waiting).';

-- The pending proposals (draft / sent / accepted) of other requests whose ride sits in this proposal's car slot.
create or replace function public._proposal_blockers(p_proposal_id uuid) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct o.id), '{}'::uuid[])
  from public.proposals p
  cross join lateral public._proposal_car_holds(p.payload, p.type) mine
  cross join lateral (select make_interval(mins => coalesce(public.required_turnaround_minutes(p.department_id, p.week_start), 30)) as buf) b
  join public.rides r on r.car_id = mine.car_id and r.status <> 'cancelled'
    and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(mine.from_at - b.buf, mine.to_at + b.buf, '[)')
  join public.ride_requests rr on rr.ride_id = r.id
  join public.proposals o on o.request_id = rr.request_id and o.id <> p.id and o.request_id <> p.request_id
    and o.department_id = p.department_id and o.week_start = p.week_start and o.status in ('draft', 'sent', 'accepted')
  where p.id = p_proposal_id
$$;

-- Two or more accepted proposals that only block each other (a swap): applied together in one sub-transaction, the same
-- way swap_day_cars() exchanges two cars — the car-overlap constraint deferred and `app.day_car_swap` on (rides_before_write
-- and prepare_manual_ride_window skip their neighbour checks), then overlap + turnaround checked on the final state of the
-- group's rides. Tries the order forwards and then backwards. False (nothing changed) otherwise.
create or replace function public._apply_proposal_group(p_proposal_id uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid[] := array[p_proposal_id];
  v_more uuid[];
  v_id uuid;
  v_grew boolean := true;
  v_order uuid[];
  v_try integer;
  v_prev_auto text := coalesce(current_setting('app.auto_applying_proposal', true), '');
  v_prev_sst text := coalesce(current_setting('app.system_status_transition', true), '');
  v_prev_applying text := coalesce(current_setting('app.applying_proposal', true), '');
  v_prev_group text := coalesce(current_setting('app.applying_proposal_group', true), '');
  v_prev_swap text := coalesce(current_setting('app.day_car_swap', true), '');
begin
  while v_grew loop
    v_grew := false;
    foreach v_id in array v_group loop
      v_more := array(select x from unnest(public._proposal_blockers(v_id)) x where not (x = any(v_group)));
      if cardinality(v_more) > 0 then
        v_group := v_group || v_more;
        v_grew := true;
      end if;
    end loop;
  end loop;
  if cardinality(v_group) < 2 or exists (select 1 from public.proposals where id = any(v_group) and status <> 'accepted') then
    return false;
  end if;
  v_order := array(select id from public.proposals where id = any(v_group) order by created_at, id);
  for v_try in 1 .. 2 loop
    begin
      set constraints public.rides_no_overlap_per_car deferred;
      perform set_config('app.applying_proposal_group', 'on', true);
      perform set_config('app.auto_applying_proposal', 'on', true);
      perform set_config('app.day_car_swap', 'on', true);
      foreach v_id in array v_order loop
        perform public.apply_proposal(v_id);
      end loop;
      perform set_config('app.day_car_swap', v_prev_swap, true);
      if exists (
        select 1
        from public.proposals p
        join public.ride_requests rr on rr.request_id = p.request_id
        join public.rides r1 on r1.id = rr.ride_id
        join public.rides r2 on r2.car_id = r1.car_id and r2.id <> r1.id
        where p.id = any(v_group) and r1.status <> 'cancelled' and r2.status <> 'cancelled'
          and not r1.planning_conflict and not r2.planning_conflict
          and not (r1.series_id is not null and r1.series_id = r2.series_id)
          and tstzrange(r1.starts_at, r1.blocked_until, '[)') && tstzrange(r2.starts_at, r2.blocked_until, '[)')
      ) then
        raise exception 'ride_turnaround_conflict' using errcode = '23P01';
      end if;
      set constraints public.rides_no_overlap_per_car immediate;
      perform set_config('app.auto_applying_proposal', v_prev_auto, true);
      perform set_config('app.applying_proposal_group', v_prev_group, true);
      update public.proposals set waiting_for = '{}'::uuid[] where id = any(v_group) and waiting_for <> '{}'::uuid[];
      return true;
    exception when others then
      set constraints public.rides_no_overlap_per_car immediate;
      perform set_config('app.day_car_swap', v_prev_swap, true);
      perform set_config('app.auto_applying_proposal', v_prev_auto, true);
      perform set_config('app.system_status_transition', v_prev_sst, true);
      perform set_config('app.applying_proposal', v_prev_applying, true);
      perform set_config('app.applying_proposal_group', v_prev_group, true);
    end;
    v_order := array(select x from unnest(v_order) with ordinality t(x, n) order by n desc);
  end loop;
  return false;
end $$;

-- Applies an accepted proposal; when it cannot apply because another pending proposal still holds its room, it waits
-- (`waiting_for`, or applies together with the proposals it is swapping with); otherwise it is withdrawn as stale
-- (`p_silent`: nobody is told — "כן, כבר סיכמנו" asked nobody). Returns {status: applied|waiting|withdrawn, reason?, waiting_for?}.
create or replace function public._apply_or_wait(p_proposal_id uuid, p_silent boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_msg text;
  v_block uuid[];
  v_prev_auto text := coalesce(current_setting('app.auto_applying_proposal', true), '');
  v_prev_sst text := coalesce(current_setting('app.system_status_transition', true), '');
  v_prev_applying text := coalesce(current_setting('app.applying_proposal', true), '');
  v_prev_supp text := coalesce(current_setting('app.suppress_notifications', true), '');
begin
  begin
    perform set_config('app.auto_applying_proposal', 'on', true);
    perform public.apply_proposal(p_proposal_id);
    perform set_config('app.auto_applying_proposal', v_prev_auto, true);
    update public.proposals set waiting_for = '{}'::uuid[] where id = p_proposal_id and waiting_for <> '{}'::uuid[];
    return jsonb_build_object('status', 'applied');
  exception when others then
    v_msg := sqlerrm;
    perform set_config('app.auto_applying_proposal', v_prev_auto, true);
    perform set_config('app.system_status_transition', v_prev_sst, true);
    perform set_config('app.applying_proposal', v_prev_applying, true);
  end;
  v_block := public._proposal_blockers(p_proposal_id);
  if cardinality(v_block) > 0 then
    if public._apply_proposal_group(p_proposal_id) then
      return jsonb_build_object('status', 'applied');
    end if;
    update public.proposals set waiting_for = v_block where id = p_proposal_id;
    return jsonb_build_object('status', 'waiting', 'waiting_for', to_jsonb(v_block));
  end if;
  if p_silent then perform set_config('app.suppress_notifications', 'on', true); end if;
  perform public.proposal_system_withdraw(p_proposal_id, 'withdrawn_stale', v_msg);
  perform set_config('app.suppress_notifications', v_prev_supp, true);
  return jsonb_build_object('status', 'withdrawn', 'reason', v_msg);
end $$;

-- When a proposal applies, the proposals waiting for it are retried; when it is declined, withdrawn or expires, they are
-- withdrawn (`withdrawn_dependency`). Not while a swap group is being applied (the group handles its own members).
create or replace function public.proposals_release_waiters() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare w record;
begin
  if new.status = old.status or coalesce(current_setting('app.applying_proposal_group', true), '') = 'on' then
    return null;
  end if;
  if new.status = 'applied' then
    for w in select id from public.proposals where status = 'accepted' and new.id = any(waiting_for) order by created_at, id loop
      update public.proposals set waiting_for = array_remove(waiting_for, new.id) where id = w.id;
      if (select status from public.proposals where id = w.id) = 'accepted' then
        perform public._apply_or_wait(w.id);
      end if;
    end loop;
  elsif new.status in ('declined', 'withdrawn', 'expired') then
    for w in select id from public.proposals where status = 'accepted' and new.id = any(waiting_for) order by created_at, id loop
      perform public.proposal_system_withdraw(w.id, 'withdrawn_dependency', null);
    end loop;
  end if;
  return null;
end $$;

create trigger proposals_release_waiters after update of status on public.proposals
  for each row execute function public.proposals_release_waiters();

-- An accepted proposal applies, waits, or is withdrawn (full definition; REQ §13.138 f replaces the inline apply/withdraw).
create or replace function public.maybe_apply_accepted_proposal(p_proposal_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_prop record; v_auto boolean;
begin
  if coalesce(current_setting('app.defer_proposal_apply', true), '') = 'on' then
    return;
  end if;
  select * into v_prop from public.proposals where id = p_proposal_id;
  if v_prop is null or v_prop.status <> 'accepted' then
    return;
  end if;
  select auto_apply_accepted_proposals into v_auto from public.department_settings where department_id = v_prop.department_id;
  if v_auto then
    -- REQ §13.102 R2B1: the member's answer always stands. If the proposal can no longer be applied (the ride moved,
    -- a turnaround or seat limit now fails, ...) it is withdrawn and the Sadran is told, instead of the answer failing;
    -- REQ §13.138 (f): unless another pending proposal still holds its room — then it waits for it.
    perform public._apply_or_wait(p_proposal_id);
  end if;
end;
$$;

-- "כן, כבר סיכמנו" (full definition; REQ §13.138 f: a proposal that waits for another one is kept, not withdrawn).
create or replace function public.agree_proposal_offline(p_proposal_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p public.proposals%rowtype;
  v_req public.requests%rowtype;
  v_prev_supp text := coalesce(current_setting('app.suppress_notifications', true), '');
  v_prev_reason text := coalesce(current_setting('app.suppressed_reason', true), '');
  v_prev_defer text := coalesce(current_setting('app.defer_proposal_apply', true), '');
  v_day date; v_public boolean := false; v_party record; v_status public.proposal_status; v_reason text;
  v_result jsonb;
begin
  select * into v_p from public.proposals where id = p_proposal_id;
  if not found then raise exception 'proposal_not_found' using errcode = 'P0001'; end if;
  if not public.can_manage_week(v_p.department_id, v_p.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if v_p.status not in ('draft', 'sent') then raise exception 'proposal_not_answerable' using errcode = 'P0001'; end if;
  select * into v_req from public.requests where id = v_p.request_id;
  -- The request's own legs and any shifted times: is any of those days already public?
  for v_day in
    select distinct (t at time zone 'Asia/Jerusalem')::date from unnest(array[
      v_req.depart_at, v_req.return_at,
      nullif(v_p.payload ->> 'depart_at', '')::timestamptz, nullif(v_p.payload ->> 'return_at', '')::timestamptz]) t
    where t is not null
  loop
    if public.is_day_public(v_p.department_id, v_p.week_start, v_day) then v_public := true; end if;
  end loop;

  perform set_config('app.suppress_notifications', 'on', true);
  perform set_config('app.suppressed_reason', '', true);
  perform set_config('app.defer_proposal_apply', 'on', true);
  if v_p.status = 'draft' then
    perform public.send_proposal(p_proposal_id);
  end if;
  for v_party in select profile_id from public.proposal_parties
                 where proposal_id = p_proposal_id and response = 'pending' order by id loop
    perform public.record_answer_on_behalf(p_proposal_id, v_party.profile_id, true, null);
  end loop;
  perform set_config('app.defer_proposal_apply', v_prev_defer, true);

  select status into v_status from public.proposals where id = p_proposal_id;
  if v_status = 'accepted' then
    -- Not public yet: the apply stays silent (members learn it at publish); public: its ordinary notices go out.
    if v_public then perform set_config('app.suppress_notifications', v_prev_supp, true); end if;
    v_result := public._apply_or_wait(p_proposal_id, true);
    v_reason := v_result ->> 'reason';
  end if;
  v_reason := coalesce(v_reason, nullif(current_setting('app.suppressed_reason', true), ''));
  perform set_config('app.suppress_notifications', v_prev_supp, true);
  perform set_config('app.suppressed_reason', v_prev_reason, true);

  if v_result ->> 'status' = 'waiting' then
    return jsonb_build_object('status', 'waiting', 'waiting_for', v_result -> 'waiting_for');
  end if;
  select status into v_status from public.proposals where id = p_proposal_id;
  if v_status = 'withdrawn' then
    return jsonb_build_object('status', 'withdrawn_stale', 'reason', v_reason);
  end if;
  return jsonb_build_object('status', 'applied', 'proposal_status', v_status);
end $$;

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select t.event::public.notification_event, ch, t.variant, t.title, t.body, t.title, t.body
from (values
  ('proposal_answered', 'withdrawn_dependency', 'ההצעה ל{{firstName}} בוטלה',
   '{{destination}}, יום {{day}} — היא חיכתה לשינוי אחר שלא אושר'),
  ('outcome_changed', 'proposal_withdrawn_dependency', 'ההצעה שאישרת בוטלה',
   '{{route}} · {{day}} — היא הייתה תלויה בשינוי אחר שלא יצא לפועל. הסדרן/ית יחזרו אליך')
) as t(event, variant, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do update
  set title = excluded.title, body = excluded.body, default_title = excluded.default_title, default_body = excluded.default_body;

-- REQ §13.138 (f): `withdrawn_dependency` tells the members who accepted, like a stale withdrawal, with its own wording
-- (full definition, otherwise unchanged).
CREATE OR REPLACE FUNCTION "public"."proposal_system_withdraw"("p_proposal_id" "uuid", "p_variant" "text", "p_reason" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_p public.proposals%rowtype; v_to uuid; v_sadranim uuid[]; v_rv jsonb;
begin
  select * into v_p from public.proposals where id = p_proposal_id for update;
  if not found or v_p.status not in ('sent','accepted') then return; end if;
  perform set_config('app.audit_reason', 'proposal_system_withdraw', true);
  update public.proposals set status = 'withdrawn', token_hash = encode(digest(public.generate_token(), 'sha256'), 'hex')
  where id = p_proposal_id;
  update public.proposal_parties set token_hash = encode(digest(public.generate_token(), 'sha256'), 'hex')
  where proposal_id = p_proposal_id;
  select coalesce(array_agg(s.profile_id), '{}') into v_sadranim from public.sadranim_of(v_p.department_id, v_p.week_start) as s(profile_id);
  -- REQ §13.103 R3B1: the members who accepted are told their answer no longer leads anywhere.
  if p_variant in ('withdrawn_stale', 'withdrawn_ride', 'withdrawn_dependency') then
    for v_to in select pp.profile_id from public.proposal_parties pp
                where pp.proposal_id = v_p.id and pp.response = 'accepted'
                  and pp.profile_id is distinct from v_p.created_by and not (pp.profile_id = any(v_sadranim)) loop
      v_rv := public.proposal_reader_vars(v_p.id, v_to);
      perform public.enqueue_notification(v_to, 'outcome_changed', v_p.department_id, v_p.week_start,
        jsonb_build_object('route', coalesce(v_rv->'vars'->>'route', ''), 'day', coalesce(v_rv->'vars'->>'day', '')),
        jsonb_build_object('variant', case when p_variant = 'withdrawn_dependency' then 'proposal_withdrawn_dependency'
          else 'proposal_withdrawn_stale' end, 'proposal_id', v_p.id, 'request_id', v_p.request_id),
        format('proposal_withdrawn_member:%s:%s', v_p.id, v_to));
    end loop;
  end if;
  for v_to in
    select x from (select v_p.created_by as x where v_p.created_by is not null and v_p.created_via = 'sadran'
                   union select unnest(v_sadranim)) y
    where x is not null
  loop
    perform public.enqueue_notification(v_to, 'proposal_answered', v_p.department_id, v_p.week_start,
      '{}'::jsonb, jsonb_build_object('variant', p_variant, 'proposal_id', v_p.id, 'request_id', v_p.request_id)
        || case when p_reason is null then '{}'::jsonb else jsonb_build_object('reason', p_reason) end,
      format('proposal_withdrawn:%s:%s', v_p.id, v_to));
  end loop;
end $$;


ALTER FUNCTION "public"."proposal_system_withdraw"("p_proposal_id" "uuid", "p_variant" "text", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."proposal_viewer_merge"("p_proposal_id" "uuid", "p_profile_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  pr public.proposals%rowtype; q public.requests%rowtype; r public.rides%rowtype;
  v_rides uuid[]; v_role text; v_leg text; v_ride_id uuid; v_mc jsonb; v_jd timestamptz; v_jr timestamptz;
  v_guest text; v_driver text;
begin
  select * into pr from public.proposals where id = p_proposal_id;
  if pr.id is null or pr.type <> 'merge' then return null; end if;
  select * into q from public.requests where id = pr.request_id;
  select full_name into v_guest from public.profiles where id = q.requester_id;
  select array_agg(x.rid order by x.ord) into v_rides
  from (select (l ->> 'ride_id')::uuid as rid, min(ord) as ord
        from jsonb_array_elements(coalesce(pr.payload -> 'legs', '[]')) with ordinality as t(l, ord)
        where coalesce(l ->> 'role', 'passenger') <> 'driver' group by (l ->> 'ride_id')::uuid) x;
  if p_profile_id = q.requester_id then
    v_role := 'guest';
    v_ride_id := v_rides[1];
    select case when count(distinct coalesce(l ->> 'leg', 'both')) > 1 or bool_or(coalesce(l ->> 'leg', 'both') = 'both') then 'both'
                else max(coalesce(l ->> 'leg', 'both')) end into v_leg
    from jsonb_array_elements(coalesce(pr.payload -> 'legs', '[]')) l where coalesce(l ->> 'role', 'passenger') <> 'driver';
  else
    select x.rid into v_ride_id
    from unnest(v_rides) with ordinality as x(rid, ord) join public.rides rd on rd.id = x.rid
    where rd.driver_id = p_profile_id
       or exists (select 1 from public.ride_requests rr join public.requests rq on rq.id = rr.request_id
                  where rr.ride_id = rd.id and rq.requester_id = p_profile_id)
    order by (rd.driver_id = p_profile_id) desc, x.ord limit 1;
    v_ride_id := coalesce(v_ride_id, v_rides[1]);
    select case when count(distinct coalesce(l ->> 'leg', 'both')) > 1 or bool_or(coalesce(l ->> 'leg', 'both') = 'both') then 'both'
                else max(coalesce(l ->> 'leg', 'both')) end into v_leg
    from jsonb_array_elements(coalesce(pr.payload -> 'legs', '[]')) l
    where (l ->> 'ride_id')::uuid = v_ride_id and coalesce(l ->> 'role', 'passenger') <> 'driver';
    v_role := case when exists (select 1 from public.rides rd where rd.id = v_ride_id and rd.driver_id = p_profile_id) then 'host' else 'other' end;
  end if;
  if v_ride_id is null or v_leg is null then return null; end if;
  select * into r from public.rides where id = v_ride_id;
  select full_name into v_driver from public.profiles where id = r.driver_id;
  select jt.dep, jt.ret into v_jd, v_jr from public._joiner_times(r.id, q.id, v_leg::public.ride_leg) jt;
  v_mc := public._merge_check(r.id, q.id, v_leg::public.ride_leg);
  return jsonb_build_object('role', v_role, 'guestName', coalesce(v_guest, ''), 'driverName', coalesce(v_driver, ''), 'leg', v_leg,
    'rideStartsAt', r.starts_at, 'rideEndsAt', r.ends_at,
    'newStartsAt', v_mc ->> 'new_starts_at', 'newEndsAt', v_mc ->> 'new_ends_at',
    'guestDepartAt', case when v_leg in ('out', 'both') then v_jd end,
    'guestReturnAt', case when v_leg in ('return', 'both') then v_jr end,
    'ownDepartAt', case when v_leg in ('out', 'both') then q.depart_at end,
    'ownReturnAt', case when v_leg in ('return', 'both') then q.return_at end);
end $$;


ALTER FUNCTION "public"."proposal_viewer_merge"("p_proposal_id" "uuid", "p_profile_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."proposals_accepted_withdrawn_notice"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare r record; v_to uuid; v_route text; v_day text; v_names text;
begin
  for r in
    select rd.id as ride_id, rd.department_id, rd.week_start, rd.starts_at
    from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
    where rr.request_id = new.request_id and rd.status <> 'cancelled' and rd.needs_driver
  loop
    v_route := coalesce(public.request_route_label(new.request_id), '');
    v_day := public.day_date_label(r.starts_at);
    select coalesce(p.full_name, '') into v_names from public.requests q join public.profiles p on p.id = q.requester_id where q.id = new.request_id;
    select q.requester_id into v_to from public.requests q where q.id = new.request_id;
    if v_to is not null then
      perform public.enqueue_notification(v_to, 'outcome_changed', r.department_id, r.week_start,
        jsonb_build_object('route', v_route, 'day', v_day),
        jsonb_build_object('variant', 'ride_still_needs_driver', 'ride_id', r.ride_id, 'request_id', new.request_id, 'proposal_id', new.id),
        format('ride_still_needs_driver:%s:%s', new.id, v_to));
    end if;
    perform public.enqueue_notification(s.profile_id, 'outcome_changed', r.department_id, r.week_start,
      jsonb_build_object('route', v_route, 'day', v_day, 'names', coalesce(v_names, '')),
      jsonb_build_object('variant', 'ride_still_needs_driver_sadran', 'ride_id', r.ride_id, 'request_id', new.request_id, 'proposal_id', new.id),
      format('ride_still_needs_driver_sadran:%s:%s', new.id, s.profile_id))
    from public.sadranim_of(r.department_id, r.week_start) as s(profile_id)
    where s.profile_id is distinct from (select auth.uid());
  end loop;
  return new;
end $$;


ALTER FUNCTION "public"."proposals_accepted_withdrawn_notice"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."proposals_clear_inbox"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  update public.notifications set read_at = now()
  where event = 'proposal_received' and read_at is null and data ->> 'proposal_id' = new.id::text;
  return new;
end $$;


ALTER FUNCTION "public"."proposals_clear_inbox"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."proposals_send_ask_to_join"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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


ALTER FUNCTION "public"."proposals_send_ask_to_join"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."proposals_status_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_prev_flag text := coalesce(current_setting('app.system_status_transition', true), 'off');
begin
  if tg_op = 'INSERT' or new.status = old.status then
    return new;
  end if;

  if old.status = 'draft' and new.status not in ('sent','withdrawn') then
    raise exception 'invalid_proposal_transition' using errcode = 'P0001';
  elsif old.status = 'sent' and new.status not in ('accepted','declined','expired','withdrawn') then
    raise exception 'invalid_proposal_transition' using errcode = 'P0001';
  elsif old.status in ('accepted','declined','expired','withdrawn','applied') and new.status <> 'applied'
and not (old.status = 'accepted' and new.status = 'withdrawn') then
    raise exception 'invalid_proposal_transition' using errcode = 'P0001';
  elsif old.status = 'applied' then
    raise exception 'invalid_proposal_transition' using errcode = 'P0001';
  elsif new.status = 'applied' and old.status <> 'accepted' then
    raise exception 'invalid_proposal_transition' using errcode = 'P0001';
  end if;

  if new.status = 'sent' then
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = 'proposed' where id = new.request_id;
    perform set_config('app.system_status_transition', v_prev_flag, true);
  elsif new.status in ('declined','expired','withdrawn') and old.status <> 'draft' then
    -- A draft never moved its request out of its own status (only `send_proposal` does), so
    -- discarding one must not "restore" a possibly stale previous_status. Likewise a request that is no
    -- longer `proposed` (it was placed, withdrawn, ...) keeps the status something else gave it.
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = new.previous_status where id = new.request_id and status = 'proposed';
    perform set_config('app.system_status_transition', v_prev_flag, true);
  end if;

  return new;
end;
$$;

-- REQ §13.138 (f): skips the neighbour check while a swap group is applied (full definition, otherwise unchanged).
CREATE OR REPLACE FUNCTION "public"."prepare_manual_ride_window"("p_car_id" "uuid", "p_week_start" "date", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_ride_id" "uuid" DEFAULT NULL::"uuid") RETURNS smallint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_car_id::text,0));
  -- REQ §13.138 (f): a swap applied as one group checks overlap and turnaround on the final state (_apply_proposal_group).
  if coalesce(current_setting('app.day_car_swap',true),'')='on' then return null; end if;
  if coalesce(current_setting('app.coordinator_planning',true),'')='on'
    and exists(select 1 from public.cars c where c.id=p_car_id and public.can_manage_week(c.department_id,p_week_start))
    and exists(select 1 from public.rides r where r.car_id=p_car_id and r.id is distinct from p_ride_id and r.status<>'cancelled'
      and tstzrange(r.starts_at,r.ends_at,'[)') && tstzrange(p_starts_at,p_ends_at,'[)')) then return 0; end if;
  return public.prepare_manual_ride_window_before_planning(p_car_id,p_week_start,p_starts_at,p_ends_at,p_ride_id);
end $$;


ALTER FUNCTION "public"."prepare_manual_ride_window"("p_car_id" "uuid", "p_week_start" "date", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_ride_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prepare_manual_ride_window_before_planning"("p_car_id" "uuid", "p_week_start" "date", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_ride_id" "uuid" DEFAULT NULL::"uuid") RETURNS smallint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare required int; next_start timestamptz; result smallint; previous record;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_car_id::text,0));
  if p_ends_at<=p_starts_at then raise exception 'invalid_ride_window'; end if;
  if exists(select 1 from public.rides where car_id=p_car_id and id is distinct from p_ride_id and status<>'cancelled'
    and tstzrange(starts_at,ends_at,'[)') && tstzrange(p_starts_at,p_ends_at,'[)')) then
    raise exception 'ride_time_overlap' using errcode='23P01';
  end if;
  select public.required_turnaround_minutes(c.department_id,p_week_start) into required from public.cars c where c.id=p_car_id;
  for previous in select * from public.rides where car_id=p_car_id and id is distinct from p_ride_id and status<>'cancelled'
    and ends_at<=p_starts_at and blocked_until>p_starts_at order by starts_at for update loop
    update public.rides set turnaround_override_minutes=(extract(epoch from(p_starts_at-previous.ends_at))/60)::smallint where id=previous.id;
  end loop;
  select min(starts_at) into next_start from public.rides where car_id=p_car_id and id is distinct from p_ride_id and status<>'cancelled' and starts_at>=p_ends_at;
  if next_start is not null and p_ends_at+make_interval(mins=>required)>next_start then result:=(extract(epoch from(next_start-p_ends_at))/60)::smallint; end if;
  return result;
end $$;


ALTER FUNCTION "public"."prepare_manual_ride_window_before_planning"("p_car_id" "uuid", "p_week_start" "date", "p_starts_at" timestamp with time zone, "p_ends_at" timestamp with time zone, "p_ride_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."preview_day_car_swap"("p_department_id" "uuid", "p_week_start" "date", "p_day" "date", "p_car_a" "uuid", "p_car_b" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_actor uuid := (select auth.uid());
  v_day_ids uuid[];
  v_series_ids uuid[];
  v_whole_ids uuid[];
  v_blockers jsonb;
  v_notices jsonb := '[]'::jsonb;
  v_can_swap boolean;
  v_notify boolean := false;
begin
  v_blockers := public._day_car_swap_authorize(p_department_id, p_week_start, p_day, p_car_a, p_car_b, v_actor);

  if jsonb_array_length(v_blockers) = 0 then
    v_day_ids := public._day_car_swap_day_ride_ids(p_department_id, p_week_start, p_day, p_car_a, p_car_b);
    v_series_ids := public._day_car_swap_series_ids(v_day_ids);
    v_whole_ids := public._day_car_swap_expand_whole(v_day_ids);
    v_blockers := v_blockers
      || public._day_car_swap_private_car_blockers(p_car_a, p_car_b, v_actor)
      || public._day_car_swap_physical_blockers(v_whole_ids, p_car_a, p_car_b)
      || public._day_car_swap_series_day_blockers(v_whole_ids, p_day, p_car_a, p_car_b);
    if coalesce(array_length(v_day_ids, 1), 0) > 0 then
      v_notices := public._day_car_swap_notices(v_day_ids, p_car_a, p_car_b, p_day);
    end if;
    v_notify := public.is_day_public(p_department_id, p_week_start, p_day);
  else
    v_day_ids := '{}'; v_series_ids := '{}';
  end if;

  -- REQ §13.111 (a): a luggage-only blocker is waivable, so the swap can still go ahead (with allow_small_trunk).
  -- REQ §13.92 (2026-10-16): a whole_only blocker refuses only the 'whole' series mode; 'day' mode stays available.
  v_can_swap := not exists (select 1 from jsonb_array_elements(v_blockers) b
    where not coalesce((b ->> 'waivable')::boolean, false) and not coalesce((b ->> 'whole_only')::boolean, false));

  return jsonb_build_object(
    'fingerprint', public._day_car_swap_fingerprint(v_day_ids),
    'rides', public._day_car_swap_rides_json(v_day_ids),
    'series', public._day_car_swap_series_json(v_series_ids),
    'blockers', v_blockers,
    'notices', v_notices,
    'can_swap', v_can_swap,
    'whole_blocked', exists (select 1 from jsonb_array_elements(v_blockers) b where coalesce((b ->> 'whole_only')::boolean, false)),
    'needs_small_trunk', exists (select 1 from jsonb_array_elements(v_blockers) b where coalesce((b ->> 'waivable')::boolean, false)),
    'notify', v_notify
  );
end $$;


ALTER FUNCTION "public"."preview_day_car_swap"("p_department_id" "uuid", "p_week_start" "date", "p_day" "date", "p_car_a" "uuid", "p_car_b" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."profile_phones"("p_ids" "uuid"[]) RETURNS TABLE("id" "uuid", "phone" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select p.id, public.phone_of(p.id)
  from public.profiles p
  where p.id = any(coalesce(p_ids, '{}'::uuid[]));
$$;
