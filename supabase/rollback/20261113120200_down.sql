-- Down for 20261113120200_urea_care.sql (FU2, REQ item 219): restores the care-event tires check of tire fill / wash
-- only. NOT VALID: urea fills logged meanwhile stay; new writes are checked. The enum values ('urea_fill', 'urea')
-- cannot be removed and stay unused; the redefined functions keep working for the previous frontend.
alter table public.car_care_events drop constraint car_care_events_tires_ck;
alter table public.car_care_events add constraint car_care_events_tires_ck
  check ((kind = 'tire_fill' and tires is not null) or (kind = 'wash' and tires is null)) not valid;
