-- REQ item 264 (owner 2026-11-23): a replacement car has its own licence plate. Optional, free text like cars.license_plate,
-- and beside the replacement code so it follows the same department-scoped RLS.
alter table public.car_access_codes add column replacement_plate text;
comment on column public.car_access_codes.replacement_plate is 'The replacement car''s licence plate while is_replaced; cleared when the replacement ends.';
