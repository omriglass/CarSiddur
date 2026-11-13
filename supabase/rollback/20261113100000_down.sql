-- Down for 20261113100000_replacement_code_may_match.sql (RC1, REQ item 214): restores the rule that a replacement
-- code differs from the car's own code. NOT VALID: rows saved meanwhile with equal codes stay; new writes are checked.
alter table public.car_access_codes drop constraint car_access_codes_replacement_ck;
alter table public.car_access_codes add constraint car_access_codes_replacement_ck
  check ((not is_replaced) or (access_code is not null and replacement_code is not null and replacement_code <> access_code)) not valid;
