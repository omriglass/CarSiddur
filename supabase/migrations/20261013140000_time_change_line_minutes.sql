-- R6B9 (REQ §13.109): a shift text lists only what changed. Times are compared at the minute the text prints
-- ("יציאה 12:00 במקום 12:00" came from two instants a few seconds apart). Full create or replace; no other change.

create or replace function public._time_change_line(_old_start timestamptz, _old_end timestamptz, _new_start timestamptz, _new_end timestamptz, _day_level boolean DEFAULT false) RETURNS text
    LANGUAGE plpgsql STABLE
    SET search_path = public, pg_temp
    AS $$
declare
  v_parts text[] := '{}';
  v_day boolean;
begin
  if _new_start is not null and date_trunc('minute', _old_start) is distinct from date_trunc('minute', _new_start) then
    if _old_start is null then
      v_parts := v_parts || public._frag(case when _day_level then 'time.depart_day_set' else 'time.depart_set' end,
        jsonb_build_object('new', case when _day_level then public.day_date_label(_new_start) || ' ' || public._hhmm(_new_start) else public._hhmm(_new_start) end));
    else
      v_day := _day_level or (_old_start at time zone 'Asia/Jerusalem')::date <> (_new_start at time zone 'Asia/Jerusalem')::date;
      v_parts := v_parts || public._frag(case when v_day then 'time.depart_day_change' else 'time.depart_change' end,
        jsonb_build_object(
          'new', case when v_day then public.day_date_label(_new_start) || ' ' || public._hhmm(_new_start) else public._hhmm(_new_start) end,
          'old', case when v_day then public.day_date_label(_old_start) || ' ' || public._hhmm(_old_start) else public._hhmm(_old_start) end));
    end if;
  end if;
  if _new_end is not null and date_trunc('minute', _old_end) is distinct from date_trunc('minute', _new_end) then
    if _old_end is null then
      v_parts := v_parts || public._frag(case when _day_level then 'time.return_day_set' else 'time.return_set' end,
        jsonb_build_object('new', case when _day_level then public.day_date_label(_new_end) || ' ' || public._hhmm(_new_end) else public._hhmm(_new_end) end));
    else
      v_day := _day_level or (_old_end at time zone 'Asia/Jerusalem')::date <> (_new_end at time zone 'Asia/Jerusalem')::date;
      v_parts := v_parts || public._frag(case when v_day then 'time.return_day_change' else 'time.return_change' end,
        jsonb_build_object(
          'new', case when v_day then public.day_date_label(_new_end) || ' ' || public._hhmm(_new_end) else public._hhmm(_new_end) end,
          'old', case when v_day then public.day_date_label(_old_end) || ' ' || public._hhmm(_old_end) else public._hhmm(_old_end) end));
    end if;
  end if;
  return array_to_string(v_parts, ' · ');
end $$;
