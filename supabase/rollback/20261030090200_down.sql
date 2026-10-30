-- Down for 20261030090200_draft_holds_the_car.sql: the overlap constraint without the draft-hold exemption.
-- (The `draft_hold` column, the helper functions and triggers may stay; with every flag cleared they change nothing.)
update public.rides set draft_hold = false where draft_hold;
alter table public.rides drop constraint rides_no_overlap_per_car;
alter table public.rides add constraint rides_no_overlap_per_car exclude using gist
  (car_id with =, tstzrange(starts_at, ends_at, '[)') with &&)
  where (status <> 'cancelled'::public.ride_status and not planning_conflict) deferrable;
drop trigger if exists proposals_sync_draft_hold on public.proposals;
drop trigger if exists ride_requests_respect_draft_holds on public.ride_requests;
