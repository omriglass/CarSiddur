-- Consent-based overlapping proposals. Confirmed rides keep their exclusion constraint.
-- REQ §8, §9; TODO shadow ride cancellation request.
create table public.ride_change_requests (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  week_start date not null,
  requester_id uuid not null references public.profiles(id) on delete cascade,
  ride_id uuid not null references public.rides(id) on delete cascade,
  car_id uuid not null references public.cars(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  expected_version int not null,
  status text not null default 'pending' check(status in ('pending','accepted','declined','cancelled')),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  foreign key(department_id,week_start) references public.weeks(department_id,week_start),
  check(ends_at>starts_at and public.is_quarter_hour(starts_at) and public.is_quarter_hour(ends_at))
);
create unique index ride_change_one_pending on public.ride_change_requests(ride_id) where status='pending';
create index ride_change_week on public.ride_change_requests(department_id,week_start,status);
create table public.ride_change_parties (
  id uuid primary key default gen_random_uuid(),
  change_id uuid not null references public.ride_change_requests(id) on delete cascade,
  ride_id uuid not null references public.rides(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  expected_version int not null,accepted boolean,responded_at timestamptz,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  unique(change_id,ride_id)
);
create index ride_change_parties_profile on public.ride_change_parties(profile_id,change_id);
create trigger set_updated_at before update on public.ride_change_requests for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.ride_change_parties for each row execute function public.set_updated_at();
alter table public.ride_change_requests enable row level security;
alter table public.ride_change_requests force row level security;
alter table public.ride_change_parties enable row level security;
alter table public.ride_change_parties force row level security;
create policy ride_change_requests_select on public.ride_change_requests for select to authenticated using(
  requester_id=(select auth.uid()) or public.can_manage_week(department_id,week_start)
  or (public.is_approved() and public.is_week_public(department_id,week_start))
);
create policy ride_change_parties_select on public.ride_change_parties for select to authenticated using(
  profile_id=(select auth.uid()) or exists(select 1 from public.ride_change_requests ch where ch.id=change_id)
);
revoke all on public.ride_change_requests,public.ride_change_parties from anon;
grant select on public.ride_change_requests,public.ride_change_parties to authenticated;

create function public.request_ride_change(p_ride_id uuid,p_car_id uuid,p_starts_at timestamptz,p_ends_at timestamptz,p_expected_version int) returns uuid
security definer set search_path = public, pg_temp language plpgsql as $$
declare r public.rides%rowtype; other public.rides%rowtype; ch uuid; buffer interval; cnt int:=0;
begin
  select * into r from public.rides where id=p_ride_id for update;
  if not found then raise exception 'ride_not_found'; end if;
  if not public.is_approved() or r.driver_id is distinct from (select auth.uid()) or not public.is_week_public(r.department_id,r.week_start) then raise exception 'not_authorized'; end if;
  if r.status='cancelled' or r.version<>p_expected_version then perform public.raise_stale_version(); end if;
  if p_starts_at<=now() or p_ends_at<=p_starts_at or (p_starts_at at time zone 'Asia/Jerusalem')::date<>(r.starts_at at time zone 'Asia/Jerusalem')::date then raise exception 'ride_request_day_mismatch'; end if;
  if not (public.week_range(r.week_start) @> tstzrange(p_starts_at,p_ends_at,'[)')) then raise exception 'ride_outside_week'; end if;
  if exists(select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=r.id and (q.requester_id<>r.driver_id or rr.car_mode='relay')) then raise exception 'shared_ride_requires_sadran'; end if;
  perform 1 from public.cars where id=p_car_id and department_id=r.department_id and status='active' and type='shared' for update;
  if not found then raise exception 'car_unavailable'; end if;
  select make_interval(mins=>coalesce((w.settings_overrides->>'turnaround_minutes')::int,s.turnaround_minutes)) into buffer
  from public.department_settings s join public.weeks w on w.department_id=s.department_id where w.department_id=r.department_id and w.week_start=r.week_start;
  if exists(select 1 from public.car_maintenance_blocks where car_id=p_car_id and tstzrange(starts_at,ends_at,'[)') && tstzrange(p_starts_at,p_ends_at+buffer,'[)')) then raise exception 'ride_conflicts_with_maintenance'; end if;
  update public.ride_change_requests set status='cancelled' where ride_id=r.id and status='pending';
  insert into public.ride_change_requests(department_id,week_start,requester_id,ride_id,car_id,starts_at,ends_at,expected_version)
  values(r.department_id,r.week_start,(select auth.uid()),r.id,p_car_id,p_starts_at,p_ends_at,r.version) returning id into ch;
  for other in select * from public.rides where car_id=p_car_id and id<>r.id and status<>'cancelled'
    and tstzrange(starts_at,blocked_until,'[)') && tstzrange(p_starts_at,p_ends_at+buffer,'[)') order by id for update loop
    if other.driver_id is null or other.driver_id=r.driver_id or other.origin_id<>other.destination_id
      or exists(select 1 from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=other.id and q.requester_id<>other.driver_id)
    then raise exception 'shared_ride_requires_sadran'; end if;
    insert into public.ride_change_parties(change_id,ride_id,profile_id,expected_version) values(ch,other.id,other.driver_id,other.version);
    perform public.enqueue_notification(other.driver_id,'proposal_received',r.department_id,r.week_start,
      jsonb_build_object('requesterName',(select full_name from public.profiles where id=r.driver_id),
        'date',to_char(p_starts_at at time zone 'Asia/Jerusalem','DD/MM/YY'),
        'depart',to_char(p_starts_at at time zone 'Asia/Jerusalem','HH24:MI'),'return',to_char(p_ends_at at time zone 'Asia/Jerusalem','HH24:MI')),
      jsonb_build_object('ride_change_id',ch,'ride_id',other.id,'url','/inbox?change='||ch),format('ride_change:%s:%s',ch,other.driver_id));
    cnt:=cnt+1;
  end loop;
  if cnt=0 then raise exception 'no_conflicting_ride'; end if;
  return ch;
end $$;

create function public.respond_ride_change(p_change_id uuid,p_accept boolean) returns void
security definer set search_path = public, pg_temp language plpgsql as $$
declare ch public.ride_change_requests%rowtype; r public.rides%rowtype; party record;
begin
  select * into ch from public.ride_change_requests where id=p_change_id for update;
  if not found then raise exception 'ride_change_not_found'; end if;
  if not public.is_approved() or not exists(select 1 from public.ride_change_parties where change_id=ch.id and profile_id=(select auth.uid())) then raise exception 'not_authorized'; end if;
  if ch.status<>'pending' then raise exception 'ride_change_not_pending'; end if;
  if ch.starts_at<=now() then update public.ride_change_requests set status='cancelled' where id=ch.id; return; end if;
  update public.ride_change_parties set accepted=p_accept,responded_at=now() where change_id=ch.id and profile_id=(select auth.uid());
  if not p_accept then update public.ride_change_requests set status='declined' where id=ch.id; return; end if;
  if exists(select 1 from public.ride_change_parties where change_id=ch.id and accepted is distinct from true) then return; end if;
  perform 1 from public.rides where id=ch.ride_id or id in(select ride_id from public.ride_change_parties where change_id=ch.id) order by id for update;
  select * into r from public.rides where id=ch.ride_id;
  if r.version<>ch.expected_version or r.status='cancelled' or exists(
    select 1 from public.ride_change_parties p join public.rides rd on rd.id=p.ride_id where p.change_id=ch.id and (rd.version<>p.expected_version or rd.status='cancelled')
  ) then update public.ride_change_requests set status='cancelled' where id=ch.id; return; end if;
  perform set_config('app.audit_reason','accepted_ride_change',true);
  perform set_config('app.system_status_transition','on',true);
  for party in select * from public.ride_change_parties where change_id=ch.id loop
    update public.rides set status='cancelled',cancelled_at=now(),cancelled_by=party.profile_id,cancel_reason='ACCEPTED_RIDE_CHANGE' where id=party.ride_id;
    update public.requests set status='cancelled',status_reason='RIDE_CANCELLED' where id in(select request_id from public.ride_requests where ride_id=party.ride_id);
    delete from public.ride_requests where ride_id=party.ride_id;
  end loop;
  update public.rides set car_id=ch.car_id,starts_at=ch.starts_at,ends_at=ch.ends_at,is_pinned=true,pin_reason='MEMBER_EDIT' where id=ch.ride_id;
  perform public.assert_ride_request_day(ch.ride_id);
  perform public.assert_ride_seats_fit(ch.ride_id);
  perform public.assert_car_chain(ch.car_id,ch.week_start);
  if r.car_id<>ch.car_id then perform public.assert_car_chain(r.car_id,ch.week_start); end if;
  update public.ride_change_requests set status='accepted' where id=ch.id;
  perform set_config('app.system_status_transition','off',true);
end $$;
revoke execute on function public.request_ride_change(uuid,uuid,timestamptz,timestamptz,int) from public,anon;
revoke execute on function public.respond_ride_change(uuid,boolean) from public,anon;
grant execute on function public.request_ride_change(uuid,uuid,timestamptz,timestamptz,int) to authenticated;
grant execute on function public.respond_ride_change(uuid,boolean) to authenticated;

-- Seed copy is included for upgrades as well as clean seed installs.
insert into public.notification_templates(event,channel,variant,title,body,default_title,default_body)
select 'proposal_received',channel,'ride_change','{{requesterName}} ביקש/ה לבטל את הנסיעה שלך','בקשה לרכב ב־{{date}} {{depart}}–{{return}}. האם לאשר את ביטול הנסיעה שלך?','{{requesterName}} ביקש/ה לבטל את הנסיעה שלך','בקשה לרכב ב־{{date}} {{depart}}–{{return}}. האם לאשר את ביטול הנסיעה שלך?'
from unnest(array['inbox','push']::public.notification_channel[]) channel
on conflict do nothing;
