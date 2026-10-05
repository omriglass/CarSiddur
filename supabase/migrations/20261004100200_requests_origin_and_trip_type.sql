-- Origins for requests/templates (REQ §13.93, docs/ORIGINS_PLAN_2026-10.md §2 item 2).
-- Adds origin_id/origin_text/trip_type to both `requests` and `request_templates`, backfills
-- existing rows (origin = department home; trip_type derived from the legacy fields exactly
-- as REQ §13.93 "Existing data" specifies: a one-way request, or a round trip that does not
-- need the car at the destination, becomes `drop_off`; every other round trip is `round_trip`
-- — `one_way` is never produced by the backfill, only by a client that explicitly asks for it).
-- No placement/healing behaviour changes here (that is O3) — these columns are inert until a
-- later step reads them.

alter table public.requests
  add column origin_id uuid,
  add column origin_text text,
  add column trip_type public.trip_type not null default 'round_trip';

alter table public.request_templates
  add column origin_id uuid,
  add column origin_text text,
  add column trip_type public.trip_type not null default 'round_trip';

update public.requests q
set origin_id = d.home_destination_id,
    trip_type = case when q.trip_shape = 'round_trip' and q.needs_car_at_destination
                 then 'round_trip'::public.trip_type else 'drop_off'::public.trip_type end
from public.departments d
where d.id = q.department_id;

update public.request_templates t
set origin_id = d.home_destination_id,
    trip_type = case when t.trip_shape = 'round_trip' and t.needs_car_at_destination
                 then 'round_trip'::public.trip_type else 'drop_off'::public.trip_type end
from public.departments d
where d.id = t.department_id;

alter table public.requests
  add constraint requests_origin_id_fkey foreign key (department_id, origin_id)
    references public.destinations (department_id, id),
  add constraint requests_origin_ck check (origin_id is not null or origin_text is not null);

alter table public.request_templates
  add constraint request_templates_origin_id_fkey foreign key (department_id, origin_id)
    references public.destinations (department_id, id),
  add constraint request_templates_origin_ck check (origin_id is not null or origin_text is not null);

-- Defense in depth: `submit_request` (the sole INSERT path into `requests`, verified against
-- schema-current.sql) always resolves origin_id itself, so this trigger is a safety net for
-- any future direct insert that forgets to — never a behaviour change for submit_request.
create or replace function public.requests_default_origin() returns trigger
language plpgsql as $$
declare v_origin uuid;
begin
  if new.origin_id is null and new.origin_text is null then
    select dm.default_origin_id into v_origin from public.department_members dm
      where dm.department_id = new.department_id and dm.profile_id = new.requester_id and dm.removed_at is null;
    if v_origin is null then
      select home_destination_id into v_origin from public.departments where id = new.department_id;
    end if;
    new.origin_id := v_origin;
  end if;
  return new;
end;
$$;

create trigger requests_default_origin before insert on public.requests
  for each row execute function public.requests_default_origin();
