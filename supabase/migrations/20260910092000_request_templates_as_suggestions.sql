-- Repeating requests are suggestions, never auto-submissions. REQ §5.1, §12;
-- DATA_MODEL.md §3.6 `request_templates`.
--
-- Design reversal: `materialize_templates()` (20260907091500_rpc.sql) used to copy every
-- active template straight into each newly opened week as a fully `submitted` request.
-- The owner wants the opposite: a member marks a request as repeating (capturing every
-- field), and while a week is `open` the member sees it as a dismissable *suggestion* that
-- prefills the request form — nothing is ever submitted without the member tapping submit.
--
-- `requests.template_id` and `submit_request(payload)`'s `template_id` handling already
-- exist (20260907090700_requests.sql line 84; 20260907091500_rpc.sql line 103 and every
-- later patch of submit_request through 20260909093000_extend_auto_approve_and_waitlist.sql)
-- — no change needed there. This migration only touches `request_templates`,
-- `materialize_templates()`, and adds the owner-facing RPCs + suggestions view.

-- ---------------------------------------------------------------------------
-- request_templates: capture the link back to the request it was saved from, and the two
-- dismiss options (snooze this week only / stop repeating for good).
-- ---------------------------------------------------------------------------
alter table public.request_templates
  add column source_request_id uuid references public.requests(id) on delete set null,
  add column snoozed_until_week date,
  add column stopped_at timestamptz,
  add column child_ids uuid[] not null default '{}';

alter table public.request_templates
  add constraint request_templates_snoozed_until_week_sunday_ck
    check (snoozed_until_week is null or extract(dow from snoozed_until_week) = 0);

comment on column public.request_templates.paused_until is
  'Deprecated (2026-09-10): unused by the suggestion model; superseded by snoozed_until_week/stopped_at. Kept, not dropped, to avoid an unnecessary types regen.';
comment on column public.request_templates.last_materialized_week is
  'Deprecated (2026-09-10): materialize_templates() is now a no-op; this column is never written any more.';
comment on column public.request_templates.snoozed_until_week is
  'Suggestions for this template resume from this week_start onward (set to the snoozed week + 7 days by snooze_request_template()); null = never snoozed / snooze elapsed.';
comment on column public.request_templates.stopped_at is
  'Soft "stop repeating" timestamp, set together with is_active=false by stop_request_template(); resume_request_template() clears both.';
comment on column public.request_templates.source_request_id is
  'The request save_request_template() last captured this template from; requests.template_id is the primary link back (this is only a fallback lookup).';
comment on column public.request_templates.child_ids is
  'Named children (public.children) selected on the request this template was captured from, mirroring request_children — not re-validated against seat counts here since adults/child_seats are copied verbatim from the request that already passed that check.';

-- Missed when requests.template_id was added (20260907090700_requests.sql): the FK column
-- had no supporting index. Both save_request_template() (looked up via requests.template_id
-- being set) and v_request_template_suggestions (NOT EXISTS over requests.template_id) filter
-- on it, so add it now rather than opening a separate one-line migration for it.
create index if not exists requests_template_id_idx on public.requests (template_id) where template_id is not null;

-- ---------------------------------------------------------------------------
-- materialize_templates(): reversed into a no-op. Signature kept so housekeeping()'s
-- existing call site (20260907091500_rpc.sql ~line 1457) needs no change; templates now
-- power v_request_template_suggestions below instead of writing requests directly.
-- ---------------------------------------------------------------------------
create or replace function public.materialize_templates() returns int
security definer set search_path = public, pg_temp
language plpgsql as $$
begin
  return 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- save_request_template(p_request_id): create-or-update the caller's template from one of
-- their own requests. Captures every repeatable field, including named children/companions
-- and public ride details; leaves the request's own row untouched other than template_id.
-- ---------------------------------------------------------------------------
create or replace function public.save_request_template(p_request_id uuid) returns uuid
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  q public.requests%rowtype;
  v_template_id uuid;
  v_depart_dow smallint;
  v_depart_time time;
  v_return_dow smallint;
  v_return_time time;
  v_child_ids uuid[];
  v_companion_ids uuid[];
begin
  if not public.is_approved() then raise exception 'not_authorized' using errcode = 'P0001'; end if;

  select * into q from public.requests where id = p_request_id for update;
  if q is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if q.requester_id <> (select auth.uid()) then raise exception 'not_authorized' using errcode = 'P0001'; end if;

  if q.depart_at is not null then
    v_depart_dow := extract(dow from (q.depart_at at time zone 'Asia/Jerusalem'));
    v_depart_time := (q.depart_at at time zone 'Asia/Jerusalem')::time;
  end if;
  if q.return_at is not null then
    v_return_dow := extract(dow from (q.return_at at time zone 'Asia/Jerusalem'));
    v_return_time := (q.return_at at time zone 'Asia/Jerusalem')::time;
  end if;

  select coalesce(array_agg(child_id), '{}') into v_child_ids
    from public.request_children where request_id = q.id;
  select coalesce(array_agg(profile_id), '{}') into v_companion_ids
    from public.request_companions where request_id = q.id;

  v_template_id := q.template_id;
  if v_template_id is null then
    select id into v_template_id from public.request_templates where source_request_id = q.id;
  end if;

  if v_template_id is not null then
    update public.request_templates set
      destination_id = q.destination_id, destination_text = q.destination_text,
      ride_type_id = q.ride_type_id, trip_shape = q.trip_shape,
      depart_dow = v_depart_dow, depart_time = v_depart_time,
      return_dow = v_return_dow, return_time = v_return_time,
      one_way_car_mode = q.one_way_car_mode, needs_car_at_destination = q.needs_car_at_destination,
      adults = q.adults, child_seats = q.child_seats, boosters = q.boosters, has_luggage = q.has_luggage,
      flex_depart_early = q.flex_depart_early, flex_depart_late = q.flex_depart_late,
      flex_return_early = q.flex_return_early, flex_return_late = q.flex_return_late,
      notes = q.notes, preferred_car_id = q.preferred_car_id,
      ride_description = q.ride_description, guest_passenger_names = q.guest_passenger_names,
      companion_ids = v_companion_ids, child_ids = v_child_ids,
      source_request_id = q.id, is_active = true, stopped_at = null
    where id = v_template_id;
  else
    insert into public.request_templates (
      requester_id, department_id, destination_id, destination_text, ride_type_id, trip_shape,
      depart_dow, depart_time, return_dow, return_time, one_way_car_mode, needs_car_at_destination,
      adults, child_seats, boosters, has_luggage,
      flex_depart_early, flex_depart_late, flex_return_early, flex_return_late,
      notes, preferred_car_id, ride_description, guest_passenger_names, companion_ids, child_ids,
      source_request_id
    ) values (
      q.requester_id, q.department_id, q.destination_id, q.destination_text, q.ride_type_id, q.trip_shape,
      v_depart_dow, v_depart_time, v_return_dow, v_return_time, q.one_way_car_mode, q.needs_car_at_destination,
      q.adults, q.child_seats, q.boosters, q.has_luggage,
      q.flex_depart_early, q.flex_depart_late, q.flex_return_early, q.flex_return_late,
      q.notes, q.preferred_car_id, q.ride_description, q.guest_passenger_names, v_companion_ids, v_child_ids,
      q.id
    ) returning id into v_template_id;
  end if;

  update public.requests set template_id = v_template_id where id = q.id;
  return v_template_id;
end;
$$;

revoke execute on function public.save_request_template(uuid) from public, anon;
grant execute on function public.save_request_template(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- snooze_request_template(p_template_id, p_week_start): "snooze for this week" — suggestions
-- resume from the following week. p_week_start must be the week_start the suggestion was
-- shown for; the Sunday CHECK on snoozed_until_week catches a non-Sunday caller mistake.
-- ---------------------------------------------------------------------------
create or replace function public.snooze_request_template(p_template_id uuid, p_week_start date) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
begin
  if not public.is_approved() then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  update public.request_templates
    set snoozed_until_week = p_week_start + 7
  where id = p_template_id and requester_id = (select auth.uid());
  if not found then raise exception 'not_authorized' using errcode = 'P0001'; end if;
end;
$$;

revoke execute on function public.snooze_request_template(uuid, date) from public, anon;
grant execute on function public.snooze_request_template(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- stop_request_template(p_template_id): "stop repeating" — soft-stops the template so it
-- never suggests again (until resume_request_template() is called).
-- ---------------------------------------------------------------------------
create or replace function public.stop_request_template(p_template_id uuid) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
begin
  if not public.is_approved() then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  update public.request_templates
    set is_active = false, stopped_at = now()
  where id = p_template_id and requester_id = (select auth.uid());
  if not found then raise exception 'not_authorized' using errcode = 'P0001'; end if;
end;
$$;

revoke execute on function public.stop_request_template(uuid) from public, anon;
grant execute on function public.stop_request_template(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- resume_request_template(p_template_id): reactivates a stopped template (for a future "my
-- repeating requests" list; cheap to add now alongside the other three).
-- ---------------------------------------------------------------------------
create or replace function public.resume_request_template(p_template_id uuid) returns void
security definer set search_path = public, pg_temp
language plpgsql as $$
begin
  if not public.is_approved() then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  update public.request_templates
    set is_active = true, stopped_at = null
  where id = p_template_id and requester_id = (select auth.uid());
  if not found then raise exception 'not_authorized' using errcode = 'P0001'; end if;
end;
$$;

revoke execute on function public.resume_request_template(uuid) from public, anon;
grant execute on function public.resume_request_template(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- v_request_template_suggestions: for the calling member's own active templates, one row
-- per (template, open week of that template's department) that does not already have a
-- linked, non-withdrawn/cancelled/draft request in that week. security_invoker so the base
-- tables' RLS applies; the explicit requester_id filter keeps this "my own suggestions"
-- even for a caller who also happens to be a Sadran (request_templates_select lets a Sadran
-- read other members' templates, which is not what this view is for).
-- ---------------------------------------------------------------------------
create or replace view public.v_request_template_suggestions with (security_invoker = true) as
select
  t.id as template_id, t.department_id, w.week_start,
  t.destination_id, t.destination_text, coalesce(dst.name, t.destination_text) as destination_name,
  t.ride_type_id, rt.name_he as ride_type_name,
  t.trip_shape,
  t.depart_dow, t.depart_time, t.return_dow, t.return_time,
  case when t.depart_dow is not null
    then ((w.week_start + t.depart_dow)::timestamp + t.depart_time) at time zone 'Asia/Jerusalem' end as depart_at,
  case when t.return_dow is not null
    then ((w.week_start + t.return_dow)::timestamp + t.return_time) at time zone 'Asia/Jerusalem' end as return_at,
  t.one_way_car_mode, t.needs_car_at_destination,
  t.adults, t.child_seats, t.boosters, t.child_ids, t.companion_ids, t.has_luggage,
  t.flex_depart_early, t.flex_depart_late, t.flex_return_early, t.flex_return_late,
  t.preferred_car_id, t.ride_description, t.guest_passenger_names, t.notes
from public.request_templates t
join public.weeks w on w.department_id = t.department_id and w.phase = 'open'
left join public.destinations dst on dst.id = t.destination_id
join public.ride_types rt on rt.id = t.ride_type_id
where t.requester_id = (select auth.uid())
  and t.is_active
  and (t.snoozed_until_week is null or t.snoozed_until_week <= w.week_start)
  and not exists (
    select 1 from public.requests q
    where q.template_id = t.id and q.week_start = w.week_start
      and q.status not in ('withdrawn', 'cancelled', 'draft')
  );

grant select on public.v_request_template_suggestions to authenticated;
revoke all on public.v_request_template_suggestions from anon;
