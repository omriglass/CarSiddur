-- Vehicle access codes retain leading zeroes; existing cars have no stored code.
alter table public.cars
  add column access_code text,
  add column is_replaced boolean not null default false,
  add column replacement_code text,
  add constraint cars_access_code_format_ck
    check (access_code is null or access_code ~ '^[0-9]{4,5}$'),
  add constraint cars_replacement_code_format_ck
    check (replacement_code is null or replacement_code ~ '^[0-9]{4,5}$'),
  add constraint cars_replacement_codes_ck
    check (not is_replaced or (
      access_code is not null and replacement_code is not null
      and replacement_code <> access_code
    ));

-- Existing cars RLS, operational edit authority and audit triggers also govern
-- these columns. Turning replacement off clears replacement_code in the UI.
