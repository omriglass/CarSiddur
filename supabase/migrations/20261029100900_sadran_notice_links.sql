-- R15U13 (QA run 15, 2026-10-27): the Sadran's own notices (`late_request`, `request_changed`, `waitlisted_request`,
-- `auto_approved`, `claim_contested`) linked to the member route `/requests?focus=<id>` (for a contested freed car even
-- with the offer's id). For a week manager they now open the board on the request's day / the offer's claims page;
-- members keep their links (R5B4). Full definition from schema-current.sql.

create or replace function public.notification_default_url("_event" "public"."notification_event", "_data" "jsonb", "_department_id" "uuid", "_week_start" "date", "_recipient" "uuid" DEFAULT NULL::"uuid") RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_token text := nullif(_data ->> 'token', '');
  v_proposal_id uuid := nullif(_data ->> 'proposal_id', '')::uuid;
  v_ride_change_id uuid := nullif(_data ->> 'ride_change_id', '')::uuid;
  v_request_id uuid := coalesce(nullif(_data ->> 'request_id', '')::uuid, nullif(_data ->> 'offer_id', '')::uuid);
  v_ride_id uuid := nullif(_data ->> 'ride_id', '')::uuid;
  v_car_id uuid := nullif(_data ->> 'car_id', '')::uuid;
  v_group_id uuid := nullif(_data ->> 'group_id', '')::uuid;
  v_day text := nullif(_data ->> 'day', '');
  v_week_scoped boolean;
  v_sadran_role boolean;
  v_is_sadran_event boolean;
  v_manager boolean;
begin
  -- R5B4: the Sadran proposals page is for the people who manage the week; everyone else falls through to their own links.
  v_manager := _recipient is null
    or exists (select 1 from public.sadranim_of(_department_id, _week_start) s where s = _recipient)
    or exists (select 1 from public.department_members dm where dm.department_id = _department_id and dm.profile_id = _recipient
               and dm.role = 'sadran' and dm.removed_at is null)
    or exists (select 1 from public.profiles p where p.id = _recipient and p.is_admin);

  if v_token is not null then
    return '/p/' || v_token;
  end if;

  if v_proposal_id is not null and v_manager and _department_id is not null and _week_start is not null then
    return format('/sadran/%s/%s/proposals?proposal=%s', _department_id, _week_start, v_proposal_id);
  end if;

  if v_group_id is not null and v_day is not null and _department_id is not null and _week_start is not null then
    return format('/siddur/%s/%s?day=%s&group=%s', _department_id, _week_start, v_day, v_group_id);
  end if;

  if v_ride_change_id is not null then
    return format('/inbox?change=%s', v_ride_change_id);
  end if;

  -- R15U13 (QA run 15): a week manager's own Sadran notices open the Sadran screens, not the member's /requests page:
  -- a contested freed car its claims page, a late / changed / waitlisted / auto-approved request the board on its day.
  select week_scoped, sadran_role into v_week_scoped, v_sadran_role
  from public.notification_event_meta where event = _event;
  if v_manager and coalesce(v_sadran_role, false) and _department_id is not null and _week_start is not null then
    if _data ? 'offer_id' then
      return format('/sadran/%s/%s/claims/%s', _department_id, _week_start, _data ->> 'offer_id');
    end if;
    if nullif(_data ->> 'request_id', '') is not null then
      return format('/sadran/%s/%s/board?day=%s', _department_id, _week_start,
        coalesce((select to_char(coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem', 'YYYY-MM-DD')
                  from public.requests q where q.id = (_data ->> 'request_id')::uuid), ''));
    end if;
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

  select week_scoped, sadran_role into v_week_scoped, v_sadran_role
  from public.notification_event_meta where event = _event;

  if _department_id is not null and _week_start is not null and coalesce(v_week_scoped, false) then
    v_is_sadran_event := coalesce(v_sadran_role, false)
      and (_event <> 'window_open' or _data ->> 'variant' = 'sadran');
    if v_is_sadran_event then
      return format('/sadran/%s/%s', _department_id, _week_start);
    end if;
    return format('/siddur/%s/%s', _department_id, _week_start);
  end if;

  return '/inbox';
end;
$$;
