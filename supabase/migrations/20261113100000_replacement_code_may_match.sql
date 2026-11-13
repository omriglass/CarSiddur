-- RC1 (owner 2026-11-13, REQ item 214): a replacement car's code may equal the regular car's code — codes are
-- random four-digit numbers, so the two often coincide. Replacement mode still needs both codes.
alter table public.car_access_codes drop constraint car_access_codes_replacement_ck;
alter table public.car_access_codes add constraint car_access_codes_replacement_ck
  check ((not is_replaced) or (access_code is not null and replacement_code is not null));
