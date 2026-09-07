-- Coordinators may explicitly shorten preparation gaps; occupied ride times never overlap.
-- REQ §7–8; DATA_MODEL car occupancy.
alter table public.rides add column turnaround_override_minutes smallint
  check(turnaround_override_minutes between 0 and 1440);
alter table public.rides drop constraint rides_no_overlap_per_car;
alter table public.rides add constraint rides_no_overlap_per_car
  exclude using gist(car_id with =,tstzrange(starts_at,ends_at,'[)') with &&) where(status<>'cancelled');

create function public.required_turnaround_minutes(p_department_id uuid,p_week_start date) returns int
security definer stable set search_path=public,pg_temp language sql as $$
  select coalesce((w.settings_overrides->>'turnaround_minutes')::int,s.turnaround_minutes,30)
  from public.department_settings s left join public.weeks w on w.department_id=s.department_id and w.week_start=p_week_start
  where s.department_id=p_department_id;
$$;

create or replace function public.rides_before_write() returns trigger
security definer set search_path=public,pg_temp language plpgsql as $$
declare required int;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.car_id::text,0));
  required:=coalesce(public.required_turnaround_minutes(new.department_id,new.week_start),30);
  new.turnaround:=make_interval(mins=>least(required,coalesce(new.turnaround_override_minutes,required)));
  new.blocked_until:=new.ends_at+new.turnaround;
  if new.status<>'cancelled' then
    if not public.is_admin() and exists(select 1 from public.car_maintenance_blocks b where b.car_id=new.car_id
      and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(new.starts_at,new.blocked_until,'[)')) then
      raise exception 'ride_conflicts_with_maintenance';
    end if;
    if exists(select 1 from public.rides r where r.car_id=new.car_id and r.id<>new.id and r.status<>'cancelled'
      and tstzrange(r.starts_at,r.blocked_until,'[)') && tstzrange(new.starts_at,new.blocked_until,'[)')) then
      raise exception 'ride_turnaround_conflict' using errcode='23P01';
    end if;
  end if;
  return new;
end $$;
drop trigger rides_before_write on public.rides;
create trigger rides_before_write before insert or update of starts_at,ends_at,car_id,department_id,status,turnaround_override_minutes on public.rides
  for each row execute function public.rides_before_write();

-- Internal helper, invoked only after the owning operation has checked authority or consent.
create function public.prepare_manual_ride_window(p_car_id uuid,p_week_start date,p_starts_at timestamptz,p_ends_at timestamptz,p_ride_id uuid default null) returns smallint
security definer set search_path=public,pg_temp language plpgsql as $$
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

-- When an edited ride leaves a tight slot, restore any obsolete shortened gaps.
create function public.refresh_car_turnarounds(p_car_id uuid,p_week_start date) returns void
security definer set search_path=public,pg_temp language plpgsql as $$
declare r record; next_start timestamptz; required int; override_value smallint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_car_id::text,0));
  for r in select * from public.rides where car_id=p_car_id and week_start=p_week_start and status<>'cancelled' and turnaround_override_minutes is not null order by starts_at desc for update loop
    required:=public.required_turnaround_minutes(r.department_id,r.week_start);
    select min(starts_at) into next_start from public.rides where car_id=p_car_id and status<>'cancelled' and starts_at>=r.ends_at and id<>r.id;
    override_value:=case when next_start<r.ends_at+make_interval(mins=>required) then (extract(epoch from(next_start-r.ends_at))/60)::smallint end;
    if r.turnaround_override_minutes is distinct from override_value then update public.rides set turnaround_override_minutes=override_value where id=r.id; end if;
  end loop;
end $$;
revoke execute on function public.required_turnaround_minutes(uuid,date) from public,anon,authenticated;
revoke execute on function public.prepare_manual_ride_window(uuid,date,timestamptz,timestamptz,uuid) from public,anon,authenticated;
revoke execute on function public.refresh_car_turnarounds(uuid,date) from public,anon,authenticated;
