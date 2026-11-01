-- REQ §13.176 (owner 2026-11-01): a person added to a ride by name ("+ נוסעים") rides there, back or both ways.
-- The part of the ride they occupy follows it (person_ride_span). Existing rows are the whole ride, as before.
alter table public.ride_passengers add column if not exists leg public.ride_leg not null default 'both';
