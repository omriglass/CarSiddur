-- Catch up missed openings without reopening closed or published weeks.
create function public.materialize_department_weeks(p_department_id uuid,p_now timestamptz) returns int
security definer set search_path = public, pg_temp language plpgsql as $$
declare settings public.department_settings%rowtype; target date; local_day date;
  opening timestamptz; closing timestamptz; publishing timestamptz; n int; total int:=0;
begin
  select ds.* into settings from public.department_settings ds
    join public.departments d on d.id=ds.department_id
    where ds.department_id=p_department_id and d.is_active;
  if not found then return 0; end if;
  local_day:=(p_now at time zone 'Asia/Jerusalem')::date;
  for offset_weeks in 0..greatest(0,settings.weeks_open_ahead) loop
    target:=local_day-extract(dow from local_day)::int+7*offset_weeks;
    opening:=((target-7+settings.open_dow)+settings.open_time) at time zone 'Asia/Jerusalem';
    if opening > p_now then continue; end if;
    closing:=((target-7+settings.close_dow)+settings.close_time) at time zone 'Asia/Jerusalem';
    publishing:=((target-7+settings.publish_dow)+settings.publish_time) at time zone 'Asia/Jerusalem';
    insert into public.weeks(department_id,week_start,phase,open_at,close_at,publish_at)
      values(p_department_id,target,'open',opening,closing,publishing)
      on conflict(department_id,week_start) do nothing;
    get diagnostics n=row_count;
    total:=total+n;
  end loop;
  return total;
end $$;
revoke all on function public.materialize_department_weeks(uuid,timestamptz) from public,anon,authenticated;

create function public.notify_week_opened() returns trigger
security definer set search_path = public, pg_temp language plpgsql as $$
begin
  if new.phase <> 'open' then return new; end if;
  perform public.enqueue_notification(dm.profile_id,'window_open',new.department_id,new.week_start,
    '{}','{}',format('window_open:%s:%s',new.department_id,new.week_start))
    from public.department_members dm join public.profiles p on p.id=dm.profile_id
    where dm.department_id=new.department_id and dm.removed_at is null and p.approval_status='approved';
  perform public.enqueue_notification(s.profile_id,'window_open',new.department_id,new.week_start,
    jsonb_build_object('closeTime',to_char(new.close_at at time zone 'Asia/Jerusalem','DD/MM HH24:MI'),
      'publishTime',to_char(new.publish_at at time zone 'Asia/Jerusalem','DD/MM HH24:MI')),
    jsonb_build_object('variant','sadran','url','/sadran'),
    format('window_open_sadran:%s:%s',new.department_id,new.week_start))
    from public.sadranim_of(new.department_id,new.week_start) s(profile_id)
    join public.profiles p on p.id=s.profile_id where p.approval_status='approved';
  return new;
end $$;
revoke all on function public.notify_week_opened() from public,anon,authenticated;
create trigger notify_week_opened after insert on public.weeks
  for each row execute function public.notify_week_opened();

create or replace function public.advance_week_phases(p_now timestamptz default now()) returns int
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_count int := 0;
  v_dept record;
  v_week record;
begin
  for v_dept in select id from public.departments where is_active loop
    v_count := v_count + public.materialize_department_weeks(v_dept.id, p_now);
  end loop;

  for v_week in select * from public.weeks where phase = 'open' and close_at <= p_now loop
    update public.weeks set phase = 'solving' where department_id = v_week.department_id and week_start = v_week.week_start;
    perform public.enqueue_notification(s.profile_id, 'window_closed_solve_now', v_week.department_id, v_week.week_start,
      '{}'::jsonb, '{}'::jsonb, format('window_closed_solve_now:%s:%s', v_week.department_id, v_week.week_start))
    from public.sadranim_of(v_week.department_id, v_week.week_start) as s(profile_id);
    v_count := v_count + 1;
  end loop;

  update public.weeks set phase = 'archived'
  where phase in ('published', 'live') and (week_start + 7) <= (p_now at time zone 'Asia/Jerusalem')::date;

  update public.weeks set phase = 'live'
  where phase = 'published' and week_start <= ((p_now at time zone 'Asia/Jerusalem')::date - extract(dow from p_now at time zone 'Asia/Jerusalem')::int);

  return v_count;
end;
$$;

revoke execute on function public.advance_week_phases(timestamptz) from public, anon, authenticated;


-- No caller-controlled clock or horizon; only an approved member's department or an admin.
create function public.ensure_department_weeks(p_department_id uuid) returns void
security definer set search_path = public, pg_temp language plpgsql as $$
declare w record;
begin
  if not (public.is_admin() or public.member_of(p_department_id)) then
    raise exception 'not_authorized' using errcode='P0001';
  end if;
  perform public.materialize_department_weeks(p_department_id,now());
  for w in update public.weeks set phase='solving'
    where department_id=p_department_id and phase='open' and close_at<=now()
    returning * loop
    perform public.enqueue_notification(s.profile_id,'window_closed_solve_now',w.department_id,w.week_start,
      '{}','{}',format('window_closed_solve_now:%s:%s',w.department_id,w.week_start))
      from public.sadranim_of(w.department_id,w.week_start) s(profile_id);
  end loop;
end $$;
revoke all on function public.ensure_department_weeks(uuid) from public,anon;
grant execute on function public.ensure_department_weeks(uuid) to authenticated;

-- Persisted copy is available in hosted deployments that do not load demo seed data.
insert into public.notification_templates(event,channel,variant,title,body,default_title,default_body)
select 'window_open',ch,'sadran',t.title,t.body,t.title,t.body from (values
  ('תזכורת לסדרן לשבוע {{weekLabel}}','את/ה הסדרן לשבוע {{weekLabel}}. חלון הבקשות נסגר אוטומטית ב־{{closeTime}}. יש לפרסם את הסידור עד {{publishTime}}.')
) t(title,body) cross join unnest(array['inbox','push']::public.notification_channel[]) ch
on conflict(event,channel,coalesce(variant,'')) do nothing;
