-- Contested waiting-list groups, part 5: `waitlist_contested` / `waitlist_resolved` deep
-- link to the group's block in the day's siddur. The group branch has to come BEFORE the
-- `request_id` branch, because those notifications carry the recipient's own request id
-- too (for `notification_context()`'s destination/time interpolation) and would otherwise
-- fall through to `/requests?focus=…`.
-- Reproduced verbatim from 20260909099500_extend_notification_default_url_car_id.sql with
-- one addition (consistency decision 23: one URL, computed once, in SQL).
-- REQ §7.3; DATA_MODEL.md §3.11; UX_FLOWS.md §2.1.
create or replace function public.notification_default_url(
  _event public.notification_event,
  _data jsonb,
  _department_id uuid,
  _week_start date
) returns text
language plpgsql stable as $$
declare
  v_token text := nullif(_data ->> 'token', '');
  v_proposal_id uuid := nullif(_data ->> 'proposal_id', '')::uuid;
  v_ride_change_id uuid := nullif(_data ->> 'ride_change_id', '')::uuid;
  v_request_id uuid := coalesce(nullif(_data ->> 'request_id', '')::uuid, nullif(_data ->> 'offer_id', '')::uuid);
  v_ride_id uuid := nullif(_data ->> 'ride_id', '')::uuid;
  v_car_id uuid := nullif(_data ->> 'car_id', '')::uuid;
  v_group_id uuid := nullif(_data ->> 'group_id', '')::uuid;
  v_day text := nullif(_data ->> 'day', '');
  v_is_sadran_event boolean;
begin
  if v_token is not null then
    return '/p/' || v_token;
  end if;

  if v_proposal_id is not null and _department_id is not null and _week_start is not null then
    return format('/sadran/%s/%s/proposals?proposal=%s', _department_id, _week_start, v_proposal_id);
  end if;

  if v_group_id is not null and v_day is not null and _department_id is not null and _week_start is not null then
    return format('/siddur/%s/%s?day=%s&group=%s', _department_id, _week_start, v_day, v_group_id);
  end if;

  if v_ride_change_id is not null then
    return format('/inbox?change=%s', v_ride_change_id);
  end if;

  if v_request_id is not null then
    return format('/requests?focus=%s', v_request_id);
  end if;

  if v_ride_id is not null and _department_id is not null and _week_start is not null then
    return format('/siddur/%s/%s?ride=%s', _department_id, _week_start, v_ride_id);
  end if;

  if v_car_id is not null then
    return format('/cars/%s', v_car_id);
  end if;

  if _department_id is not null and _week_start is not null
    and _event in ('published', 'window_open', 'window_closing', 'window_closed_solve_now', 'publish_reminder')
  then
    v_is_sadran_event := _event in ('window_closed_solve_now', 'publish_reminder')
      or (_event = 'window_open' and _data ->> 'variant' = 'sadran');
    if v_is_sadran_event then
      return format('/sadran/%s/%s', _department_id, _week_start);
    end if;
    return format('/siddur/%s/%s', _department_id, _week_start);
  end if;

  return '/inbox';
end;
$$;

revoke execute on function public.notification_default_url(public.notification_event, jsonb, uuid, date) from public, anon;
grant execute on function public.notification_default_url(public.notification_event, jsonb, uuid, date) to authenticated;
