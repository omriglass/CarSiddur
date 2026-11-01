-- REQ §13.177 (b) (owner 2026-11-01): the admin picks each ride type's colour. Departments set up their own codes
-- (production: job, garden, other), which the browser's fixed code → colour map did not know, so every ride was grey.
create type public.ride_type_color as enum ('blue', 'pink', 'teal', 'orange', 'gray', 'green', 'yellow', 'red');

alter table public.ride_types add column if not exists color public.ride_type_color;
comment on column public.ride_types.color is
  'Ride blocks, legend and charts colour (REQ §13.177 b); null = by code for the seeded codes, else gray.';

-- Existing types: the seeded codes keep the colour they had; every other type gets the next unused colour of the
-- department, in sort order.
update public.ride_types set color = case code
    when 'work' then 'blue' when 'childcare' then 'pink' when 'healthcare' then 'teal'
    when 'errands' then 'orange' when 'other' then 'gray' end::public.ride_type_color
  where color is null and code in ('work', 'childcare', 'healthcare', 'errands', 'other');

do $$
declare
  t record;
  v_color public.ride_type_color;
begin
  for t in select id, department_id from public.ride_types where color is null order by department_id, sort_order, id loop
    select c into v_color
      from unnest(array['blue', 'green', 'orange', 'pink', 'teal', 'yellow', 'red']::public.ride_type_color[]) with ordinality as p(c, n)
      where not exists (select 1 from public.ride_types o where o.department_id = t.department_id and o.color = p.c)
      order by n limit 1;
    update public.ride_types set color = coalesce(v_color, 'gray') where id = t.id;
  end loop;
end $$;
