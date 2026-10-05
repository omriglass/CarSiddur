-- O3 (REQ §13.93, ORIGINS_PLAN §3): a temporary car's rides must start and end at the same
-- place -- its base (the owner's default origin, else home, ORIGINS_PLAN §1/§2 item 4/6) --
-- not necessarily the department home. Checking `new.origin_id = new.destination_id` is the
-- origin-generic equivalent of the old `= department home` test: a temporary car never relays
-- regardless of where its base is. Full create-or-replace (hard rule 8).
create or replace function public.rides_temp_car_never_relays() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_type public.car_type;
begin
  select c.type into v_type from public.cars c where c.id = new.car_id;
  if v_type = 'temporary' and new.origin_id <> new.destination_id then
    raise exception 'temporary_car_never_relays' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
