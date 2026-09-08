-- Run after migrations + seed. Transaction leaves the demo fixtures unchanged.
begin;
do $$
declare
  member_id uuid:=gen_random_uuid(); admin_id uuid:='00000000-0000-0000-0000-000000000101';
  dept uuid:='00000000-0000-0000-0000-000000000001';
  notification_count integer; n public.notifications%rowtype; subscription uuid;
begin
  assert not exists (
    select 1 from unnest(enum_range(null::public.notification_event)) e
    cross join unnest(array['inbox','push']::public.notification_channel[]) ch
    where not exists(select 1 from public.notification_templates t where t.event=e and t.channel=ch and t.variant is null)
  ), 'all production events need default templates';
  insert into auth.users(id,email,raw_user_meta_data)
    values(member_id,member_id::text||'@notification.test','{}');
  select * into n from public.notifications where recipient_id=admin_id and event='access_request' and data->>'profile_id'=member_id::text;
  assert n.id is not null and n.title_he<>'' and n.body_he like '%'||member_id::text||'@notification.test%', 'pending signup must notify admin with actual applicant';
  assert n.data->>'url'='/admin/members', 'access request needs approval deep link';

  insert into public.push_subscriptions(profile_id,endpoint,p256dh,auth)
    values(member_id,'https://notification.test/'||member_id,'test','test') returning id into subscription;
  update public.profiles set muted_events=array['status_changed','access_approved']::public.notification_event[] where id=member_id;
  update public.profiles set approval_status='approved' where id=member_id;
  select * into n from public.notifications where recipient_id=member_id and event='access_approved';
  assert n.id is not null and n.title_he<>'' and n.body_he<>'', 'approval alert missing';
  assert exists(select 1 from public.push_outbox where notification_id=n.id and subscription_id=subscription),'approval push missing';
  update public.profiles set is_admin=true where id=member_id;
  assert exists(select 1 from public.notifications where recipient_id=member_id and data->>'variant'='admin_granted'), 'admin promotion alert missing';
  insert into public.department_members(department_id,profile_id,role) values(dept,member_id,'member');
  update public.department_members set role='sadran' where profile_id=member_id and department_id=dept;
  select * into n from public.notifications where recipient_id=member_id and data->>'variant'='sadran';
  assert n.id is not null and n.body_he like '%'||(select name from public.departments where id=dept)||'%', 'sadran promotion alert needs department';
  select count(*) into notification_count from public.notifications where recipient_id=member_id;
  update public.profiles set full_name='Only name changed',is_admin=true where id=member_id;
  update public.department_members set role='sadran' where profile_id=member_id and department_id=dept;
  assert (select count(*) from public.notifications where recipient_id=member_id)=notification_count,'unrelated/no-op edits must not notify';
  update public.profiles set is_admin=false,approval_status='blocked' where id=member_id;
  assert exists(select 1 from public.notifications where recipient_id=member_id and data->>'variant'='admin_revoked'),'admin revocation alert missing';
  assert exists(select 1 from public.notifications where recipient_id=member_id and data->>'variant'='blocked'),'blocked alert missing';
  update public.department_members set removed_at=now() where profile_id=member_id and department_id=dept;
  assert exists(select 1 from public.notifications where recipient_id=member_id and data->>'variant'='removed'),'membership removal alert missing';
  assert not exists(select 1 from public.notifications where recipient_id=member_id and (body_he='' or title_he='' or body_he like '%{{%')),'status messages must render completely';
end $$;
rollback;
