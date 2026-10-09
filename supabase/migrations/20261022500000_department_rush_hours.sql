-- REQ §13.113 (owner 2026-10-09): rush hours. Two weekday windows (Sunday-Thursday, Asia/Jerusalem
-- wall clock) and the percentage by which the part of a drive inside a window is longer. Read by
-- the request form only (it stretches "arrive by" / "leave there at" conversions); the solver,
-- route_minutes_preview and ride lengths do not use it. Members already read their own
-- department's row (department_settings_select); the admin writes through department_settings_update.
alter table public.department_settings
  add column rush_morning_start time not null default '07:00',
  add column rush_morning_end time not null default '09:30',
  add column rush_morning_percent smallint not null default 30,
  add column rush_afternoon_start time not null default '15:30',
  add column rush_afternoon_end time not null default '18:30',
  add column rush_afternoon_percent smallint not null default 20,
  add constraint department_settings_rush_morning_ck check (rush_morning_start < rush_morning_end),
  add constraint department_settings_rush_afternoon_ck check (rush_afternoon_start < rush_afternoon_end),
  add constraint department_settings_rush_order_ck check (rush_morning_end <= rush_afternoon_start),
  add constraint department_settings_rush_percent_ck check (
    rush_morning_percent between 0 and 100 and rush_afternoon_percent between 0 and 100
  );
