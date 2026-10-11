-- Owner 2026-10-11 (REQ §13.126 g): "הרכב זמין לשימוש ביעד" — a round trip the member drives both ways, stored as the two
-- legs of a הקפצה with a pickup (trip_type 'drop_off', trip_shape 'round_trip') that ALWAYS connect on one car: the car
-- waits at the destination, open to trips that start and end there (connect_drop_off_legs already allows those), and
-- the member takes it home on the return leg. Members see a round trip with "the car is available at X", not a הקפצה.
alter table public.requests add column keep_car_at_destination boolean not null default false;
alter table public.requests add constraint requests_keep_car_at_destination_ck
  check (not keep_car_at_destination or (trip_type = 'drop_off' and trip_shape = 'round_trip'));
comment on column public.requests.keep_car_at_destination is
  'REQ §13.126 g: a member-driven round trip whose car stays at the destination between the legs (two connected relay legs on one car, never split by the wait-needed-elsewhere rule).';
