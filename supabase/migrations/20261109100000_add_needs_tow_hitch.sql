-- REQ §13.200: a request can need a towing car (רכב גורר, car feature `tow_hitch`), the second car need beside
-- large luggage (REQ §13.101 a / §13.111 a). Same rule, same waiver: `luggage_waived_at/_by` now mean "this
-- request's car needs are waived" (one waiver for both needs).

alter table public.requests
  add column needs_tow_hitch boolean not null default false;
alter table public.request_templates
  add column needs_tow_hitch boolean not null default false;

comment on column public.requests.needs_tow_hitch is
  'REQ §13.200: the request needs a car with the tow_hitch feature (at most one such request per ride). Waived together with large luggage by luggage_waived_at.';

-- browser code reads requests by column (REQ §13.153): the new column is granted like has_luggage.
grant select (needs_tow_hitch) on table public.requests to authenticated;

-- The waiver may now stand on either need.
alter table public.requests drop constraint requests_luggage_waiver_ck;
alter table public.requests add constraint requests_luggage_waiver_ck
  check (luggage_waived_at is null or has_luggage or needs_tow_hitch);

-- Editing either need (on or off) restores the requirement; an edit that leaves both as they were keeps the waiver.
create or replace function public.requests_clear_luggage_waiver() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.luggage_waived_at is not null
     and (new.has_luggage is distinct from old.has_luggage or new.needs_tow_hitch is distinct from old.needs_tow_hitch) then
    new.luggage_waived_at := null;
    new.luggage_waived_by := null;
  end if;
  return new;
end $$;

create or replace trigger requests_clear_luggage_waiver
  before update of has_luggage, needs_tow_hitch on public.requests
  for each row execute function public.requests_clear_luggage_waiver();

-- Does this request still need a towing car? (waived = no)
create or replace function public.request_needs_tow_hitch(p_request_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select q.needs_tow_hitch and q.luggage_waived_at is null from public.requests q where q.id = p_request_id), false);
$$;
revoke all on function public.request_needs_tow_hitch(uuid) from public, anon, authenticated;

-- One verdict for both car needs: _luggage large-luggage requests need a large trunk (any number),
-- _tow towing requests need a hitch and at most one may ride together (one hitch).
create or replace function public.car_meets_needs(_car uuid, _luggage int, _tow int) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select public.car_takes_luggage(_car, _luggage)
     and (coalesce(_tow, 0) <= 0
          or (_tow <= 1 and exists (select 1 from public.cars c where c.id = _car and 'tow_hitch' = any(c.features))));
$$;
revoke all on function public.car_meets_needs(uuid, int, int) from public, anon, authenticated;
