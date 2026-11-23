-- REQ item 264 (owner 2026-11-23): a replacement car may have no code, and a car with no regular code may be replaced.
-- Only the rule tying "replaced" to both codes goes; each code keeps its own 4-5 digit format check.
alter table public.car_access_codes drop constraint car_access_codes_replacement_ck;
