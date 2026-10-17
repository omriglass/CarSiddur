-- REQ §13.137 (owner 2026-10-17): one-time back-fill. Requests, stops and repeating templates filed
-- before 20261026120200 whose typed destination/origin/stop matches exactly one approved place of their
-- department are linked to it — the same rules as link_typed_places_on_approval(): only requests not yet
-- placed (draft, submitted, waitlisted, denied, external), not in an archived week, without a sent or
-- accepted proposal; a text matching two places stays text. Data only; no schema change.

do $$
declare v_prev text := coalesce(current_setting('app.audit_reason', true), '');
begin
  perform set_config('app.audit_reason', 'place_linked', true);

  with m as (
    select q.id,
           case when q.destination_id is null and q.destination_text is not null
                then public.match_department_place(q.department_id, q.destination_text) end as dest,
           case when q.origin_id is null and q.origin_text is not null
                then public.match_department_place(q.department_id, q.origin_text) end as orig
    from public.requests q
    where q.status in ('draft', 'submitted', 'waitlisted', 'denied', 'external')
      and ((q.destination_id is null and q.destination_text is not null)
           or (q.origin_id is null and q.origin_text is not null))
      and exists (select 1 from public.weeks w where w.department_id = q.department_id
                  and w.week_start = q.week_start and w.phase <> 'archived')
      and not exists (select 1 from public.proposals p where p.request_id = q.id and p.status in ('sent', 'accepted'))
  )
  update public.requests q set
    destination_id = coalesce(m.dest, q.destination_id),
    destination_text = case when m.dest is not null then null else q.destination_text end,
    origin_id = coalesce(m.orig, q.origin_id),
    origin_text = case when m.orig is not null then null else q.origin_text end
  from m
  where q.id = m.id and (m.dest is not null or m.orig is not null);

  update public.request_stops s set
    place_id = public.match_department_place(s.department_id, s.place_text),
    place_text = null
  from public.requests q
  where q.id = s.request_id and s.place_id is null and s.place_text is not null
    and q.status in ('draft', 'submitted', 'waitlisted', 'denied', 'external')
    and exists (select 1 from public.weeks w where w.department_id = q.department_id
                and w.week_start = q.week_start and w.phase <> 'archived')
    and public.match_department_place(s.department_id, s.place_text) is not null;

  update public.request_templates t set
    destination_id = public.match_department_place(t.department_id, t.destination_text),
    destination_text = null
  where t.destination_id is null and t.destination_text is not null
    and public.match_department_place(t.department_id, t.destination_text) is not null;

  update public.request_templates t set
    origin_id = public.match_department_place(t.department_id, t.origin_text),
    origin_text = null
  where t.origin_id is null and t.origin_text is not null
    and public.match_department_place(t.department_id, t.origin_text) is not null;

  perform set_config('app.audit_reason', v_prev, true);
end $$;
