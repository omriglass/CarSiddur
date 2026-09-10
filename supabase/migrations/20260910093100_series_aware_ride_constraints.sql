-- REQ §13.77 — the two scheduling guards that a multi-day series would otherwise trip.
--
-- (a) rides_before_write(): the day-1 leg ends 23:59:00 and the day-2 leg starts 00:00:00,
--     so `blocked_until = ends_at + turnaround` (default 30 min) always overlaps the next
--     leg and raised `ride_turnaround_conflict`. The car never leaves the member's hands
--     between two legs of the same series, so there is nothing to turn around: the buffer
--     check is skipped between two rides that share a non-null series_id. The plain GIST
--     exclusion (starts_at, ends_at) still applies — [.., 23:59) and [00:00, ..) do not
--     overlap, so two legs still cannot double-book a car.
--
-- (b) assert_car_chain(): two changes.
--     1. The chain no longer assumes "every car starts the week at home" — it seeds from
--        the last non-cancelled ride that *starts before* the week, so a series that runs
--        Saturday -> Sunday keeps the car at the destination across the week boundary.
--        car_location_at() is not used here because its `starts_at <= _at` window also
--        matches a ride starting exactly at the week's Jerusalem midnight (the carry-over
--        leg itself), which would seed the chain from its own destination.
--     2. `car_away_at_day_end` is not raised for a leg that is followed by another leg of
--        the same series on the next calendar day — that overnight stay is the booking.

create or replace function public.rides_before_write() returns trigger
security definer set search_path=public,pg_temp language plpgsql as $$
declare required int; collision boolean; planning boolean; same_window boolean:=false;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.car_id::text,0));
  required:=coalesce(public.required_turnaround_minutes(new.department_id,new.week_start),30);
  planning:=coalesce(current_setting('app.coordinator_planning',true),'')='on'
    and public.can_manage_week(new.department_id,new.week_start);
  if tg_op='UPDATE' then same_window:=new.car_id=old.car_id and new.starts_at=old.starts_at and new.ends_at=old.ends_at and new.status=old.status; end if;
  select exists(select 1 from public.rides r where r.car_id=new.car_id and r.id<>new.id and r.status<>'cancelled'
    and tstzrange(r.starts_at,r.ends_at,'[)') && tstzrange(new.starts_at,new.ends_at,'[)')) into collision;
  if planning and collision then
    -- Existing published rides are intercepted by edit_ride and saved as shadows.
    if tg_op='UPDATE' and old.status<>'draft' then raise exception 'published_ride_requires_planning_shadow'; end if;
    new.status:='draft'; new.planning_conflict:=true; new.turnaround_override_minutes:=0;
  elsif new.planning_conflict then
    if new.status<>'draft' or not collision then new.planning_conflict:=false;
    elsif not same_window then raise exception 'not_authorized'; end if;
  end if;
  new.turnaround:=make_interval(mins=>least(required,coalesce(new.turnaround_override_minutes,required)));
  new.blocked_until:=new.ends_at+new.turnaround;
  if new.status<>'cancelled' then
    if not public.is_admin() and exists(select 1 from public.car_maintenance_blocks b where b.car_id=new.car_id
      and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(new.starts_at,new.blocked_until,'[)')) then raise exception 'ride_conflicts_with_maintenance'; end if;
    if not new.planning_conflict and exists(select 1 from public.rides r where r.car_id=new.car_id and r.id<>new.id and r.status<>'cancelled'
      and (not same_window or not r.planning_conflict)
      -- REQ §13.77: consecutive legs of one multi-day series need no turnaround buffer.
      and not (new.series_id is not null and r.series_id = new.series_id)
      and tstzrange(r.starts_at,r.blocked_until,'[)') && tstzrange(new.starts_at,new.blocked_until,'[)')) then
      raise exception 'ride_turnaround_conflict' using errcode='23P01';
    end if;
  end if;
  return new;
end $$;

create or replace function public.assert_car_chain(_car uuid, _week date) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_home uuid; v_day_end time; v_loc uuid; v_car_name text; v_week_starts timestamptz; r record;
begin
  select d.home_destination_id, s.day_end_time, c.name into v_home, v_day_end, v_car_name
  from public.cars c
  join public.departments d on d.id = c.department_id
  join public.department_settings s on s.department_id = d.id
  where c.id = _car;
  if v_home is null then raise exception 'no_home_location' using errcode = 'P0412'; end if;

  v_week_starts := (_week::timestamp) at time zone 'Asia/Jerusalem';
  -- Where the car actually is when the week opens (home unless a previous week's ride —
  -- typically a multi-day series leg — left it somewhere else).
  select coalesce((select p.destination_id from public.rides p
                   where p.car_id = _car and p.status <> 'cancelled' and not p.planning_conflict
                     and p.starts_at < v_week_starts
                   order by p.starts_at desc limit 1), v_home)
    into v_loc;

  for r in
    select id, origin_id, destination_id, starts_at, ends_at, overnight_ack_by, series_id
    from public.rides
    where car_id = _car and week_start = _week and status <> 'cancelled' and not planning_conflict
    order by starts_at
  loop
    if r.origin_id <> v_loc then
      raise exception 'car_chain_broken' using errcode = 'P0410',
        detail = format('%s %s–%s', v_car_name,
          to_char(r.starts_at at time zone 'Asia/Jerusalem', 'DD/MM HH24:MI'),
          to_char(r.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI'));
    end if;
    v_loc := r.destination_id;

    if r.destination_id <> v_home and r.overnight_ack_by is null
      -- REQ §13.77: the next leg of the same series takes the car over the night.
      and not (r.series_id is not null and exists (
        select 1 from public.rides s
        where s.car_id = _car and s.status <> 'cancelled' and not s.planning_conflict
          and s.series_id = r.series_id and s.id <> r.id
          and (s.starts_at at time zone 'Asia/Jerusalem')::date
              = (r.ends_at at time zone 'Asia/Jerusalem')::date + 1))
    then
      if not exists (
        select 1 from public.rides n
        where n.car_id = _car and n.status <> 'cancelled' and not n.planning_conflict and n.starts_at > r.ends_at
          and n.starts_at < (((r.ends_at at time zone 'Asia/Jerusalem')::date + v_day_end) at time zone 'Asia/Jerusalem')
      ) then
        raise exception 'car_away_at_day_end' using errcode = 'P0411',
          detail = format('%s %s–%s', v_car_name,
            to_char(r.starts_at at time zone 'Asia/Jerusalem', 'DD/MM HH24:MI'),
            to_char(r.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI'));
      end if;
    end if;
  end loop;
end $$;
