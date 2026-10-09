-- REQ §13.114: the maintenance refusal of `rides_before_write` applies to a new ride or a changed car/window only
-- (found by the API suite: a responsible member / Sadran extending a period over a booked ride failed, because the
-- `flag_rides_in_maintenance` trigger's own status update was refused by this check). Copied in full from the
-- applied definition; only that one condition changed.

CREATE OR REPLACE FUNCTION public.rides_before_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare required int; collision boolean; planning boolean; same_window boolean:=false;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.car_id::text,0));
  required:=coalesce(public.required_turnaround_minutes(new.department_id,new.week_start),30);
  planning:=coalesce(current_setting('app.coordinator_planning',true),'')='on'
    and public.can_manage_week(new.department_id,new.week_start);
  if tg_op='UPDATE' then same_window:=new.car_id=old.car_id and new.starts_at=old.starts_at and new.ends_at=old.ends_at and new.status=old.status; end if;
  select coalesce(current_setting('app.day_car_swap',true),'')<>'on' and exists(select 1 from public.rides r where r.car_id=new.car_id and r.id<>new.id and r.status<>'cancelled'
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
      and (not same_window or not r.planning_conflict)
      -- REQ §13.77: consecutive legs of one multi-day series need no turnaround buffer.
      and not (new.series_id is not null and r.series_id = new.series_id)
      and tstzrange(r.starts_at,r.blocked_until,'[)') && tstzrange(new.starts_at,new.blocked_until,'[)')) then
      raise exception 'ride_turnaround_conflict' using errcode='23P01';
    end if;
  end if;
  return new;
end $function$;
