-- REQ §13.203: asking another member to make room is a shorter ride (return earlier / leave later) or giving it up,
-- sent only after the two talked; a new waiting-list request can ask too (no ride of the requester yet).

-- What each asked driver agreed to: their ride's new hours, or null/null = give the ride up (`cut` = 'cancel').
alter table public.ride_change_parties
  add column cut text check (cut is null or cut in ('end', 'start', 'cancel')),
  add column new_starts_at timestamptz,
  add column new_ends_at timestamptz;

comment on column public.ride_change_parties.cut is
  'REQ §13.203: end = return earlier (new_ends_at), start = leave later (new_starts_at), cancel (or null, older rows) = give the ride up.';

-- A request change asked for a new request (the waiting-list round trip to place) instead of moving a ride.
alter table public.ride_change_requests
  alter column ride_id drop not null,
  add column request_id uuid references public.requests(id) on delete cascade,
  add column talked boolean not null default false,
  add constraint ride_change_requests_target check (is_planning or ((ride_id is null) <> (request_id is null)));

comment on column public.ride_change_requests.request_id is
  'REQ §13.203 (d): the waiting-list request placed on car_id at starts_at–ends_at once every party accepts (ride_id is then null).';
comment on column public.ride_change_requests.talked is
  'REQ §13.203 (a): the requester confirmed they talked with the asked drivers ("דיברתי עם X").';

create unique index ride_change_one_pending_request on public.ride_change_requests (request_id) where status = 'pending';
create index ride_change_requests_request_id_idx on public.ride_change_requests (request_id) where request_id is not null;
