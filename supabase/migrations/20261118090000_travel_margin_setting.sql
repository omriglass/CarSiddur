-- REQ item 249 (c) (owner 2026-11-17, TT1): a department travel margin. Every drive estimate is longer by this
-- percent at all hours (first the margin, then the rush-hour windows stretch the result), wherever the app shows or
-- works out a time from a drive. Default 0 = nothing changes until the admin sets it. The solver, merges and joins
-- keep the plain minutes. Members already read their own department's row; the admin writes through
-- department_settings_update.
alter table public.department_settings
  add column travel_margin_percent smallint not null default 0,
  add constraint department_settings_travel_margin_ck check (travel_margin_percent between 0 and 200);

comment on column public.department_settings.travel_margin_percent is
  'REQ item 249 (c): extra percent on every drive estimate shown or worked out (before rush hours); 0 = none.';
