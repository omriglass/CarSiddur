-- REQ §13.137: a typed place that is on the list becomes that place.
-- (a) on save: requests / request_stops / request_templates store a matching approved place of the
--     department as place_id instead of text; (b) on approval (or rename / alias change of an approved
--     place): open, unplaced requests and templates are linked. Internal functions only, no grants.

create or replace function public.normalize_place_text(p_text text)
returns text language sql immutable set search_path = public, pg_temp as $$
  select nullif(lower(btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g'))), '')
$$;

-- The id of the ONE approved destination of the department whose normalized name or any normalized
-- alias equals the normalized text; null when none or more than one (destinations are always
-- department-scoped, there are no global rows).
create or replace function public.match_department_place(p_department_id uuid, p_text text)
returns uuid language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_norm text := public.normalize_place_text(p_text); v_ids uuid[];
begin
  if v_norm is null or p_department_id is null then return null; end if;
  select array_agg(d.id) into v_ids
  from public.destinations d
  where d.department_id = p_department_id and d.is_approved
    and (public.normalize_place_text(d.name) = v_norm
         or exists (select 1 from unnest(d.aliases) a where public.normalize_place_text(a) = v_norm));
  if v_ids is null or cardinality(v_ids) <> 1 then return null; end if;
  return v_ids[1];
end $$;

create or replace function public.requests_link_typed_places()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if new.destination_id is null and new.destination_text is not null
     and (tg_op = 'INSERT' or new.destination_text is distinct from old.destination_text) then
    v_id := public.match_department_place(new.department_id, new.destination_text);
    if v_id is not null then new.destination_id := v_id; new.destination_text := null; end if;
  end if;
  if new.origin_id is null and new.origin_text is not null
     and (tg_op = 'INSERT' or new.origin_text is distinct from old.origin_text) then
    v_id := public.match_department_place(new.department_id, new.origin_text);
    if v_id is not null then new.origin_id := v_id; new.origin_text := null; end if;
  end if;
  return new;
end $$;

create or replace function public.request_stops_link_typed_places()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if new.place_id is null and new.place_text is not null
     and (tg_op = 'INSERT' or new.place_text is distinct from old.place_text) then
    v_id := public.match_department_place(new.department_id, new.place_text);
    if v_id is not null then new.place_id := v_id; new.place_text := null; end if;
  end if;
  return new;
end $$;

create or replace function public.request_templates_link_typed_places()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if new.destination_id is null and new.destination_text is not null
     and (tg_op = 'INSERT' or new.destination_text is distinct from old.destination_text) then
    v_id := public.match_department_place(new.department_id, new.destination_text);
    if v_id is not null then new.destination_id := v_id; new.destination_text := null; end if;
  end if;
  if new.origin_id is null and new.origin_text is not null
     and (tg_op = 'INSERT' or new.origin_text is distinct from old.origin_text) then
    v_id := public.match_department_place(new.department_id, new.origin_text);
    if v_id is not null then new.origin_id := v_id; new.origin_text := null; end if;
  end if;
  return new;
end $$;

create trigger requests_link_typed_places
  before insert or update of destination_id, destination_text, origin_id, origin_text on public.requests
  for each row execute function public.requests_link_typed_places();
create trigger request_stops_link_typed_places
  before insert or update of place_id, place_text on public.request_stops
  for each row execute function public.request_stops_link_typed_places();
create trigger request_templates_link_typed_places
  before insert or update of destination_id, destination_text, origin_id, origin_text on public.request_templates
  for each row execute function public.request_templates_link_typed_places();

-- On approval: link what is still waiting. Not-yet-placed statuses only (draft, submitted, waitlisted,
-- denied, external); 'proposed' and anything assigned/merged/withdrawn/cancelled stay as they are, as
-- do requests in an archived week and requests with a sent/accepted proposal (an edit would withdraw it).
create or replace function public.link_typed_places_on_approval()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_prev text := coalesce(current_setting('app.audit_reason', true), '');
begin
  perform set_config('app.audit_reason', 'place_linked', true);

  -- one UPDATE per request, so the version bumps once
  update public.requests q set
    destination_id = case when q.destination_id is null and q.destination_text is not null
                           and public.match_department_place(q.department_id, q.destination_text) = new.id
                          then new.id else q.destination_id end,
    destination_text = case when q.destination_id is null and q.destination_text is not null
                             and public.match_department_place(q.department_id, q.destination_text) = new.id
                            then null else q.destination_text end,
    origin_id = case when q.origin_id is null and q.origin_text is not null
                      and public.match_department_place(q.department_id, q.origin_text) = new.id
                     then new.id else q.origin_id end,
    origin_text = case when q.origin_id is null and q.origin_text is not null
                        and public.match_department_place(q.department_id, q.origin_text) = new.id
                       then null else q.origin_text end
  where q.department_id = new.department_id
    and q.status in ('draft', 'submitted', 'waitlisted', 'denied', 'external')
    and ((q.destination_id is null and q.destination_text is not null)
         or (q.origin_id is null and q.origin_text is not null))
    and exists (select 1 from public.weeks w where w.department_id = q.department_id
                and w.week_start = q.week_start and w.phase <> 'archived')
    and not exists (select 1 from public.proposals p where p.request_id = q.id and p.status in ('sent', 'accepted'))
    and (public.match_department_place(q.department_id, q.destination_text) = new.id
         or public.match_department_place(q.department_id, q.origin_text) = new.id);

  update public.request_stops s set place_id = new.id, place_text = null
  from public.requests q
  where q.id = s.request_id and s.department_id = new.department_id
    and s.place_id is null and s.place_text is not null
    and q.status in ('draft', 'submitted', 'waitlisted', 'denied', 'external')
    and exists (select 1 from public.weeks w where w.department_id = q.department_id
                and w.week_start = q.week_start and w.phase <> 'archived')
    and public.match_department_place(s.department_id, s.place_text) = new.id;

  update public.request_templates t set destination_id = new.id, destination_text = null
  where t.department_id = new.department_id and t.destination_id is null and t.destination_text is not null
    and public.match_department_place(t.department_id, t.destination_text) = new.id;
  update public.request_templates t set origin_id = new.id, origin_text = null
  where t.department_id = new.department_id and t.origin_id is null and t.origin_text is not null
    and public.match_department_place(t.department_id, t.origin_text) = new.id;

  perform set_config('app.audit_reason', v_prev, true);
  return null;
end $$;

create trigger destinations_link_typed_places
  after update on public.destinations
  for each row
  when (new.is_approved and (not old.is_approved or new.name is distinct from old.name
                             or new.aliases is distinct from old.aliases))
  execute function public.link_typed_places_on_approval();

revoke all on function public.normalize_place_text(text) from public;
revoke all on function public.match_department_place(uuid, text) from public;
revoke all on function public.requests_link_typed_places() from public;
revoke all on function public.request_stops_link_typed_places() from public;
revoke all on function public.request_templates_link_typed_places() from public;
revoke all on function public.link_typed_places_on_approval() from public;
