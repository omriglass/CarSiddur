-- REQ §13.101 b / docs/COPY_DRAFT_2026-10.md: old -> new wording is built from admin-editable
-- `text_fragments` (never Hebrew inside SQL logic) by these helpers; proposal and outcome-change
-- notification copy (20261007100100 onward) renders the lines they return.
insert into public.text_fragments (key, body) values
  ('time.depart_change',     'יציאה {{new}} במקום {{old}}'),
  ('time.return_change',     'חזרה {{new}} במקום {{old}}'),
  ('time.depart_day_change', 'יציאה ביום {{new}} במקום {{old}}'),
  ('time.return_day_change', 'חזרה ביום {{new}} במקום {{old}}'),
  ('time.unchanged',         'השעות שלך לא משתנות'),
  ('time.same_with_car',     'אותן שעות, ברכב {{car}}'),
  ('join.both',              'יציאה {{depart}}, חזרה {{return}}'),
  ('join.out',               'הלוך בלבד, יציאה {{depart}}'),
  ('join.return',            'חזור בלבד, חזרה {{return}}'),
  ('detour.line',            ' · כ-{{detourMin}} דק׳ נוספות בדרך'),
  ('reason.line',            'סיבה: {{reason}}'),
  ('reason.default',         'אין מספיק רכבים פנויים'),
  ('change.car',             'רכב {{newCar}} במקום {{oldCar}}'),
  ('change.driver',          'נהג/ת: {{driverName}}')
on conflict (key) do update set body = excluded.body, updated_at = now();

-- A fragment rendered with `_vars` ('' when the key is missing).
create or replace function public._frag(_key text, _vars jsonb default '{}'::jsonb)
returns text
language sql stable
set search_path = public, pg_temp
as $$
  select public.render_notification_text(coalesce((select f.body from public.text_fragments f where f.key = _key), ''), _vars);
$$;

create or replace function public._hhmm(_at timestamptz)
returns text
language sql stable
set search_path = public, pg_temp
as $$ select to_char(_at at time zone 'Asia/Jerusalem', 'HH24:MI'); $$;

-- "יציאה 11:15 במקום 11:30 · חזרה 17:00 במקום 17:30": only the parts that differ, '' when nothing does.
-- A NULL new value means "that leg is not affected". `_day_level` (series spans) always names the day.
create or replace function public._time_change_line(
  _old_start timestamptz, _old_end timestamptz, _new_start timestamptz, _new_end timestamptz,
  _day_level boolean default false)
returns text
language plpgsql stable
set search_path = public, pg_temp
as $$
declare
  v_parts text[] := '{}';
  v_day boolean;
begin
  if _new_start is not null and _old_start is distinct from _new_start then
    v_day := _day_level or (_old_start at time zone 'Asia/Jerusalem')::date <> (_new_start at time zone 'Asia/Jerusalem')::date;
    v_parts := v_parts || public._frag(case when v_day then 'time.depart_day_change' else 'time.depart_change' end,
      jsonb_build_object(
        'new', case when v_day then public.day_date_label(_new_start) || ' ' || public._hhmm(_new_start) else public._hhmm(_new_start) end,
        'old', case when v_day then public.day_date_label(_old_start) || ' ' || public._hhmm(_old_start) else public._hhmm(_old_start) end));
  end if;
  if _new_end is not null and _old_end is distinct from _new_end then
    v_day := _day_level or (_old_end at time zone 'Asia/Jerusalem')::date <> (_new_end at time zone 'Asia/Jerusalem')::date;
    v_parts := v_parts || public._frag(case when v_day then 'time.return_day_change' else 'time.return_change' end,
      jsonb_build_object(
        'new', case when v_day then public.day_date_label(_new_end) || ' ' || public._hhmm(_new_end) else public._hhmm(_new_end) end,
        'old', case when v_day then public.day_date_label(_old_end) || ' ' || public._hhmm(_old_end) else public._hhmm(_old_end) end));
  end if;
  return array_to_string(v_parts, ' · ');
end $$;

revoke all on function public._frag(text, jsonb) from public;
revoke all on function public._hhmm(timestamptz) from public;
revoke all on function public._time_change_line(timestamptz, timestamptz, timestamptz, timestamptz, boolean) from public;
grant execute on function public._frag(text, jsonb) to service_role;
grant execute on function public._hhmm(timestamptz) to service_role;
grant execute on function public._time_change_line(timestamptz, timestamptz, timestamptz, timestamptz, boolean) to service_role;
