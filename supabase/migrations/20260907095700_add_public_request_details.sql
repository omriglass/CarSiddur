-- Public ride details and named passengers are independent of private request notes.
-- REQ §5.1; DATA_MODEL requests/templates/companions.
alter table public.requests add column ride_description text, add column guest_passenger_names text[] not null default '{}';
alter table public.request_templates add column ride_description text, add column guest_passenger_names text[] not null default '{}',
  add column companion_ids uuid[] not null default '{}';

create function public.normalize_public_request_details() returns trigger
security definer set search_path=public,pg_temp language plpgsql as $$
begin
  new.ride_description:=nullif(trim(new.ride_description),'');
  if length(new.ride_description)>1000 then raise exception 'invalid_ride_description';end if;
  select coalesce(array_agg(trim(name) order by n),'{}') into new.guest_passenger_names
    from unnest(coalesce(new.guest_passenger_names,'{}')) with ordinality x(name,n) where nullif(trim(name),'') is not null;
  if cardinality(new.guest_passenger_names)>20 or exists(select 1 from unnest(new.guest_passenger_names) name where length(name)>100) then raise exception 'invalid_passenger_names';end if;
  if tg_table_name='request_templates' then
    new.companion_ids:=coalesce(new.companion_ids,'{}');
    if cardinality(new.companion_ids)>20 or cardinality(new.companion_ids)<>(select count(distinct id) from unnest(new.companion_ids) id)
      or exists(select 1 from unnest(new.companion_ids) candidate(profile_id) where candidate.profile_id=new.requester_id or not exists(
        select 1 from public.profiles p join public.department_members dm on dm.profile_id=p.id
        where p.id=candidate.profile_id and p.approval_status='approved' and dm.department_id=new.department_id and dm.removed_at is null)) then raise exception 'invalid_companions';end if;
    if cardinality(new.companion_ids)+cardinality(new.guest_passenger_names)>new.adults+new.child_seats+new.boosters-1 then raise exception 'passenger_names_exceed_seats';end if;
  end if;
  return new;
end $$;
create trigger requests_public_details before insert or update of ride_description,guest_passenger_names on public.requests
  for each row execute function public.normalize_public_request_details();
create trigger templates_public_details before insert or update of ride_description,guest_passenger_names,companion_ids,adults,child_seats,boosters,requester_id,department_id on public.request_templates
  for each row execute function public.normalize_public_request_details();

create function public.validate_request_companion() returns trigger
security definer set search_path=public,pg_temp language plpgsql as $$
begin
  if not exists(select 1 from public.requests q join public.department_members dm on dm.department_id=q.department_id
    join public.profiles p on p.id=dm.profile_id where q.id=new.request_id and p.id=new.profile_id
    and p.id<>q.requester_id and p.approval_status='approved' and dm.removed_at is null) then raise exception 'invalid_companions';end if;
  return new;
end $$;
create trigger request_companions_valid before insert or update on public.request_companions
  for each row execute function public.validate_request_companion();
create function public.assert_named_passenger_counts(p_request_id uuid) returns void
security definer set search_path=public,pg_temp language plpgsql as $$
declare q public.requests%rowtype; members int;
begin
  select * into q from public.requests where id=p_request_id;if not found then return;end if;
  select count(*) into members from public.request_companions where request_id=q.id;
  if members>20 then raise exception 'invalid_companions';end if;
  if members+cardinality(q.guest_passenger_names)>q.adults+q.child_seats+q.boosters-1 then raise exception 'passenger_names_exceed_seats';end if;
end $$;
create function public.request_named_passenger_counts() returns trigger
security definer set search_path=public,pg_temp language plpgsql as $$
begin
  if tg_table_name='requests' then
    if tg_op='UPDATE' and new.adults=old.adults and new.child_seats=old.child_seats and new.boosters=old.boosters and new.guest_passenger_names=old.guest_passenger_names then return null;end if;
    perform public.assert_named_passenger_counts(new.id);
  else perform public.assert_named_passenger_counts(coalesce(new.request_id,old.request_id));end if;
  return null;
end $$;
create constraint trigger requests_named_passenger_counts after insert or update of adults,child_seats,boosters,guest_passenger_names on public.requests
  deferrable initially deferred for each row execute function public.request_named_passenger_counts();
create constraint trigger companions_named_passenger_counts after insert or update or delete on public.request_companions
  deferrable initially deferred for each row execute function public.request_named_passenger_counts();
revoke execute on function public.normalize_public_request_details(),public.validate_request_companion(),public.assert_named_passenger_counts(uuid),public.request_named_passenger_counts() from public,anon,authenticated;

do $migration$
declare def text;old_text text;
begin
  def:=pg_get_functiondef('public.submit_request(jsonb)'::regprocedure);
  old_text:='  v_auto_result jsonb;';
  if strpos(def,old_text)=0 then raise exception 'unexpected_submit_declarations';end if;
  def:=replace(def,old_text,old_text||chr(10)||'  v_companion_ids uuid[];');
  old_text:='  perform set_config(''app.reset_request_baseline'',''off'',true);';
  if strpos(def,old_text)=0 then raise exception 'unexpected_submit_details_mapping';end if;
  def:=replace(def,old_text,old_text||$$
  if payload ? 'ride_description' or payload ? 'guest_passenger_names' then
    if payload ? 'ride_description' and jsonb_typeof(payload->'ride_description') not in ('string','null') then raise exception 'invalid_ride_description';end if;
    if payload ? 'guest_passenger_names' and jsonb_typeof(payload->'guest_passenger_names') not in ('array','null') then raise exception 'invalid_passenger_names';end if;
    if payload ? 'guest_passenger_names' and jsonb_typeof(payload->'guest_passenger_names')='array' and exists(
      select 1 from jsonb_array_elements(payload->'guest_passenger_names') value where jsonb_typeof(value)<>'string') then raise exception 'invalid_passenger_names';end if;
    update public.requests set ride_description=case when payload ? 'ride_description' then payload->>'ride_description' else ride_description end,
      guest_passenger_names=case when payload ? 'guest_passenger_names' then array(select jsonb_array_elements_text(case when payload->'guest_passenger_names'='null'::jsonb then '[]'::jsonb else payload->'guest_passenger_names' end)) else guest_passenger_names end
      where id=v_request_id;
  end if;
  if payload ? 'companion_ids' then
    if jsonb_typeof(payload->'companion_ids') not in ('array','null') then raise exception 'invalid_companions';end if;
    select array_agg(value::uuid) into v_companion_ids from jsonb_array_elements_text(case when payload->'companion_ids'='null'::jsonb then '[]'::jsonb else payload->'companion_ids' end);
    if cardinality(v_companion_ids)>20 or cardinality(v_companion_ids)<>(select count(distinct id) from unnest(v_companion_ids) id)
      or exists(select 1 from unnest(v_companion_ids) candidate(profile_id) where candidate.profile_id=v_requester_id or not exists(
        select 1 from public.profiles p join public.department_members dm on dm.profile_id=p.id where p.id=candidate.profile_id
        and p.approval_status='approved' and dm.department_id=v_department_id and dm.removed_at is null)) then raise exception 'invalid_companions';end if;
    delete from public.request_companions where request_id=v_request_id;
    insert into public.request_companions(request_id,profile_id) select v_request_id,id from unnest(v_companion_ids) id;
  end if;
  if payload ? 'guest_passenger_names' or payload ? 'companion_ids' then perform public.assert_named_passenger_counts(v_request_id);end if;
$$);
  execute def;

  def:=pg_get_functiondef('public.materialize_templates()'::regprocedure);
  old_text:='status, template_id, preferred_car_id)';
  if strpos(def,old_text)=0 then raise exception 'unexpected_template_details_columns';end if;
  def:=replace(def,old_text,'status, template_id, preferred_car_id, ride_description, guest_passenger_names)');
  old_text:=$$then t.preferred_car_id end);$$;
  if strpos(def,old_text)=0 then raise exception 'unexpected_template_details_values';end if;
  def:=replace(def,old_text,$$then t.preferred_car_id end, t.ride_description,t.guest_passenger_names);
      insert into public.request_companions(request_id,profile_id)
        select q.id,p.id from public.requests q cross join unnest(t.companion_ids) member_id join public.profiles p on p.id=member_id
        join public.department_members dm on dm.profile_id=p.id and dm.department_id=t.department_id and dm.removed_at is null
        where q.template_id=t.id and q.week_start=v_week.week_start and p.approval_status='approved';$$);
  execute def;

  def:=regexp_replace(pg_get_viewdef('public.v_board_rides'::regclass,true),';\s*$','');
  old_text:='q.has_luggage';
  if strpos(def,old_text)=0 then raise exception 'unexpected_board_public_details';end if;
  def:=replace(def,old_text,$$q.has_luggage,'ride_description',q.ride_description,'guest_passenger_names',q.guest_passenger_names,
    'companions',coalesce((select jsonb_agg(jsonb_build_object('profile_id',p.id,'name',p.full_name) order by p.full_name,p.id) from public.request_companions rc join public.profiles p on p.id=rc.profile_id where rc.request_id=q.id),'[]'::jsonb)$$);
  execute 'create or replace view public.v_board_rides with(security_invoker=true) as '||def;
  def:=regexp_replace(pg_get_viewdef('public.v_my_requests'::regclass,true),';\s*$','');
  execute 'create or replace view public.v_my_requests with(security_invoker=true) as select existing.*,q.ride_description,q.guest_passenger_names,
    coalesce((select jsonb_agg(jsonb_build_object(''profile_id'',p.id,''name'',p.full_name) order by p.full_name,p.id) from public.request_companions rc join public.profiles p on p.id=rc.profile_id where rc.request_id=q.id),''[]''::jsonb) as companions
    from ('||def||') existing join public.requests q on q.id=existing.request_id';
end;
$migration$;

-- Published passenger names are visible only to approved members of the ride's department.
create policy request_companions_published_select on public.request_companions for select to authenticated
using(exists(select 1 from public.requests q where q.id=request_id and public.member_of(q.department_id)
  and public.is_week_public(q.department_id,q.week_start) and exists(select 1 from public.ride_requests rr join public.rides r on r.id=rr.ride_id
    where rr.request_id=q.id and r.status not in ('draft','cancelled'))));
