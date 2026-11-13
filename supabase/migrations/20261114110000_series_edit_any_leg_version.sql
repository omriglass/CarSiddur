-- QA run 20 R20B6 (2026-11-14): editing a multi-day request from any of its days (the siddur opens that day's leg)
-- sends that leg's version; the check compared it with the first leg's version, so an edit opened on another day failed
-- with stale_version as soon as the two legs' versions differed. The expected version is now checked against the leg
-- the edit was opened on (`request_id`, when it belongs to the series), else the first leg as before.
create or replace function public._edit_series_request(payload jsonb) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_old uuid := (payload ->> 'series_id')::uuid;
  v_confirm boolean := coalesce((payload ->> 'confirm_release')::boolean, false);
  v_probe boolean := coalesce((payload ->> 'probe_only')::boolean, false);
  v_expected int := nullif(payload ->> 'expected_version', '')::int;
  v_head public.requests%rowtype;
  v_old_car uuid;
  v_was_booked boolean;
  v_new jsonb;
  v_new_ids uuid[];
  v_lost boolean := false;
  v_prev text;
  v_leg uuid;
  v_depart timestamptz := nullif(payload ->> 'depart_at', '')::timestamptz;
  v_return timestamptz := nullif(payload ->> 'return_at', '')::timestamptz;
  v_clean jsonb;
  v_legs uuid[];
  v_opened_version int;
begin
  select * into v_head from public.requests
  where series_id = v_old and status not in ('withdrawn', 'cancelled')
  order by series_index limit 1;
  if v_head.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if not public.can_edit_request(v_head.id)
     or v_head.department_id is distinct from (payload ->> 'department_id')::uuid then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  -- R20B6: the version of the leg the edit was opened on (any day of the series), else the first leg's.
  select q.version into v_opened_version from public.requests q
  where q.id = nullif(payload ->> 'request_id', '')::uuid and q.series_id = v_old and q.status not in ('withdrawn', 'cancelled');
  if v_expected is not null and v_expected <> coalesce(v_opened_version, v_head.version) then perform public.raise_stale_version(); end if;
  if v_depart is null or v_return is null then raise exception 'invalid_series_request' using errcode = 'P0001'; end if;

  -- The car the old series is on (any of its days), and whether a published day was booked.
  select rd.car_id into v_old_car
  from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id join public.requests q on q.id = rr.request_id
  where q.series_id = v_old and rd.status <> 'cancelled'
  order by rd.starts_at limit 1;
  select exists (
    select 1 from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id join public.requests q on q.id = rr.request_id
    where q.series_id = v_old and rd.status not in ('cancelled', 'draft')
  ) into v_was_booked;

  -- The new request is still the same person's; the edit keys are not filing keys.
  v_clean := (payload - 'series_id' - 'series_index' - 'series_count' - 'request_id' - 'expected_version'
              - 'confirm_release' - 'probe_only') || jsonb_build_object('requester_id', v_head.requester_id);

  v_legs := array(select id from public.requests where series_id = v_old and status not in ('withdrawn', 'cancelled') order by series_index);

  begin
    v_prev := coalesce(current_setting('app.system_status_transition', true), 'off');
    perform set_config('app.system_status_transition', 'on', true);
    perform set_config('app.audit_reason', 'series_edited', true);
    -- The series' own rides (nobody else on them) are cancelled quietly: the new span is placed again right
    -- below, so they are neither announced nor offered to the waiting list as freed cars.
    update public.rides rd set status = 'cancelled', cancelled_at = now(), cancelled_by = (select auth.uid()), cancel_reason = 'SERIES_EDITED'
    where rd.status <> 'cancelled'
      and exists (select 1 from public.ride_requests rr where rr.ride_id = rd.id and rr.request_id = any(v_legs))
      and not exists (select 1 from public.ride_requests rr where rr.ride_id = rd.id and rr.request_id <> all(v_legs))
      and not exists (select 1 from public.ride_passengers p where p.ride_id = rd.id);
    delete from public.ride_requests rr using public.rides rd
    where rd.id = rr.ride_id and rd.status = 'cancelled' and rr.request_id = any(v_legs);
    perform set_config('app.system_status_transition', v_prev, true);
    -- A day riding in someone else's ride leaves it the ordinary way (its driver is told).
    foreach v_leg in array v_legs loop
      perform public.release_request_booking(v_leg);
    end loop;
    perform set_config('app.system_status_transition', 'on', true);
    perform set_config('app.audit_reason', 'series_edited', true);
    update public.requests set status = 'withdrawn', status_reason = 'SERIES_EDITED' where id = any(v_legs);
    perform set_config('app.system_status_transition', v_prev, true);

    if (v_return at time zone 'Asia/Jerusalem')::date > (v_depart at time zone 'Asia/Jerusalem')::date then
      perform set_config('app.series_prefer_car', coalesce(v_old_car::text, ''), true);
      v_new := public.submit_series_request(v_clean);
      perform set_config('app.series_prefer_car', '', true);
      select array_agg(value::uuid) into v_new_ids from jsonb_array_elements_text(v_new -> 'request_ids');
    else
      -- shrunk to one day: an ordinary request
      v_new := public.submit_request(v_clean);
      v_new := v_new || jsonb_build_object('series_id', null, 'request_ids', jsonb_build_array(v_new ->> 'request_id'));
      v_new_ids := array[(v_new ->> 'request_id')::uuid];
    end if;

    v_lost := v_was_booked and exists (
      select 1 from public.requests q where q.id = any(v_new_ids) and q.status not in ('assigned', 'merged'));
    -- REQ §13.158: an edit never costs the car — a booked series that would not be placed again is not changed.
    if v_probe or v_lost then
      raise exception 'series_edit_rollback';
    end if;
  exception when raise_exception then
    if sqlerrm <> 'series_edit_rollback' then raise; end if;
    perform set_config('app.series_prefer_car', '', true);
    if v_probe then return jsonb_build_object('would_lose_booking', v_lost); end if;
    return jsonb_build_object('ok', false, 'edit_refused', 'no_car', 'unchanged', false);
  end;

  return v_new || jsonb_build_object('replaced_series_id', v_old);
end $$;

revoke all on function public._edit_series_request(jsonb) from public, anon, authenticated;
