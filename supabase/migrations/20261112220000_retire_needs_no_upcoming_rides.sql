-- REQ item 212 (owner 2026-11-12): a car with upcoming rides cannot be taken out of use.
-- Production case: a car was retired while two confirmed rides were still on it; retired cars are
-- hidden from the board and the siddur, so the rides vanished from view and nobody was told.
-- Retiring now refuses until those rides are moved or cancelled — for every caller and every screen
-- (the status is a plain `cars` update). Maintenance is unchanged: it has its own periods and warnings.
create or replace function public.cars_refuse_retire_with_rides() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  select count(*) into v_count
    from public.rides r
   where r.car_id = new.id and r.status <> 'cancelled' and r.ends_at > now();
  if v_count > 0 then
    raise exception 'car_has_upcoming_rides'
      using errcode = 'P0001', detail = jsonb_build_object('count', v_count)::text;
  end if;
  return new;
end;
$$;

revoke all on function public.cars_refuse_retire_with_rides() from public, anon, authenticated;

create trigger cars_refuse_retire_with_rides
  before update of status on public.cars
  for each row
  when (new.status = 'retired' and old.status is distinct from 'retired')
  execute function public.cars_refuse_retire_with_rides();
