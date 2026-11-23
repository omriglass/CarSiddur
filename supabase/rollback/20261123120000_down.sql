-- Down for 20261123120000_replacement_car_without_code: a car replaced without both codes goes back to not replaced,
-- so the old rule holds.
update public.car_access_codes set is_replaced = false, replacement_code = null
where is_replaced and (access_code is null or replacement_code is null);
alter table public.car_access_codes add constraint car_access_codes_replacement_ck
  check ((not is_replaced) or (access_code is not null and replacement_code is not null));
