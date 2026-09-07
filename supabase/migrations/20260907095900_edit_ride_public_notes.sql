-- REQ ride public details: edit public information independently of scheduling/consent.
create function public.update_ride_public_notes(
  p_ride_id uuid,
  p_expected_version int,
  p_notes text
) returns void
security definer set search_path = public, pg_temp language plpgsql as $$
declare
  ride_row public.rides%rowtype;
  week_phase public.week_phase;
  clean_notes text := nullif(btrim(p_notes), '');
begin
  if not public.is_approved() then raise exception 'not_authorized'; end if;
  select * into ride_row from public.rides where id = p_ride_id for update;
  if not found or ride_row.status = 'cancelled' then raise exception 'ride_not_found'; end if;

  if not public.can_manage_week(ride_row.department_id, ride_row.week_start) then
    if not public.member_of(ride_row.department_id)
      or not public.is_week_public(ride_row.department_id, ride_row.week_start)
      or not (
        ride_row.driver_id is not distinct from (select auth.uid())
        or exists (
          select 1 from public.ride_requests rr
          join public.requests q on q.id = rr.request_id
          where rr.ride_id = ride_row.id and q.requester_id = (select auth.uid())
        )
      )
    then raise exception 'not_authorized'; end if;
  end if;

  select phase into week_phase from public.weeks
  where department_id = ride_row.department_id and week_start = ride_row.week_start
  for share;
  if week_phase = 'archived' then raise exception 'week_archived'; end if;
  if ride_row.ends_at <= now() then raise exception 'ride_in_past'; end if;
  if p_expected_version is null or ride_row.version <> p_expected_version then
    perform public.raise_stale_version();
  end if;
  if char_length(clean_notes) > 1000
    or (clean_notes is null and ride_row.driver_id is null and not ride_row.needs_driver)
  then raise exception 'invalid_ride_description'; end if;

  -- Existing version, updated_at and audit triggers remain authoritative. No ride
  -- scheduling/status/driver fields, linked requests or consent rows are changed.
  if ride_row.notes is distinct from clean_notes then
    perform set_config('app.audit_reason', 'update_ride_public_notes', true);
    update public.rides set notes = clean_notes where id = ride_row.id;
  end if;
end;
$$;
revoke execute on function public.update_ride_public_notes(uuid, int, text) from public, anon;
grant execute on function public.update_ride_public_notes(uuid, int, text) to authenticated;
