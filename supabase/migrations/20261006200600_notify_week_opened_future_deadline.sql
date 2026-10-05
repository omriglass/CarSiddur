-- REQ §13.100 (QA run 1, QB24): the window-opening notice is only sent while its closing time is still in the future.

CREATE OR REPLACE FUNCTION public.notify_week_opened() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if new.phase <> 'open' then return new; end if;
  -- REQ §13.100 (QB24): never announce a window whose deadline already passed (a week materialized late).
  if new.close_at <= now() then return new; end if;
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
