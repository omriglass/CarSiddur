-- Complete optional car preference and preserve the member's requested times for comparison.
-- REQ §5.1–5.2; DATA_MODEL requests/request_templates.
alter table public.request_templates add column preferred_car_id uuid references public.cars(id) on delete set null;
alter table public.requests add column original_depart_at timestamptz, add column original_return_at timestamptz;

-- Earliest available request snapshot predates coordinator adjustments. Rows without
-- audit history retain their present requested times. No scheduled ride is moved.
update public.requests q set
  original_depart_at=coalesce((select (coalesce(a.before,a.after)->>'depart_at')::timestamptz from public.audit_log a
    where a.table_name='requests' and a.row_id=q.id::text order by a.at,a.id limit 1),q.depart_at),
  original_return_at=coalesce((select (coalesce(a.before,a.after)->>'return_at')::timestamptz from public.audit_log a
    where a.table_name='requests' and a.row_id=q.id::text order by a.at,a.id limit 1),q.return_at);

create function public.requests_preserve_original_times() returns trigger
language plpgsql as $$
begin
  if tg_op='INSERT' or coalesce(current_setting('app.reset_request_baseline',true),'off')='on' then
    new.original_depart_at:=new.depart_at;new.original_return_at:=new.return_at;
  else
    new.original_depart_at:=old.original_depart_at;new.original_return_at:=old.original_return_at;
  end if;
  return new;
end $$;
create trigger requests_preserve_original_times before insert or update on public.requests
  for each row execute function public.requests_preserve_original_times();

create function public.validate_preferred_car() returns trigger
security definer set search_path=public,pg_temp language plpgsql as $$
begin
  if new.preferred_car_id is null then return new; end if;
  if not exists(select 1 from public.cars c where c.id=new.preferred_car_id and c.department_id=new.department_id and c.type='shared') then
    raise exception 'invalid_preferred_car';
  end if;
  if (tg_op='INSERT' or new.preferred_car_id is distinct from old.preferred_car_id)
    and not exists(select 1 from public.cars c where c.id=new.preferred_car_id and c.status='active') then
    raise exception 'invalid_preferred_car';
  end if;
  return new;
end $$;
create trigger requests_preferred_car before insert or update of preferred_car_id,department_id on public.requests
  for each row execute function public.validate_preferred_car();
create trigger templates_preferred_car before insert or update of preferred_car_id,department_id on public.request_templates
  for each row execute function public.validate_preferred_car();
revoke execute on function public.requests_preserve_original_times() from public,anon,authenticated;
revoke execute on function public.validate_preferred_car() from public,anon,authenticated;

-- Checked substitutions retain the established RPC validation without copying it.
do $migration$
declare def text; old_text text;
begin
  def:=pg_get_functiondef('public.submit_request(jsonb)'::regprocedure);
  old_text:='preferred_car_id = coalesce(v_preferred_car_id, preferred_car_id)';
  if strpos(def,old_text)=0 then raise exception 'unexpected_submit_request_preference_mapping'; end if;
  def:=replace(def,old_text,$$preferred_car_id = case when payload ? 'preferred_car_id' then v_preferred_car_id else preferred_car_id end$$);
  old_text:='  if v_request_id is null then'||chr(10)||'    v_status := ''submitted'';';
  if strpos(def,old_text)=0 then raise exception 'unexpected_submit_request_write_block'; end if;
  def:=replace(def,old_text,$$  perform set_config('app.reset_request_baseline',case when v_requester_id=v_actor then 'on' else 'off' end,true);
$$||old_text);
  old_text:='  -- Duplicate detection';
  if strpos(def,old_text)=0 then raise exception 'unexpected_submit_request_write_end'; end if;
  def:=replace(def,old_text,$$  perform set_config('app.reset_request_baseline','off',true);
$$||old_text);
  execute def;
  def:=pg_get_functiondef('public.materialize_templates()'::regprocedure);
  if strpos(def,'notes, submitted_at, status, template_id)')=0 then raise exception 'unexpected_template_mapping'; end if;
  def:=replace(def,'notes, submitted_at, status, template_id)','notes, submitted_at, status, template_id, preferred_car_id)');
  def:=replace(def,$$t.notes, now(), 'submitted', t.id);$$,$$t.notes, now(), 'submitted', t.id, case when exists(select 1 from public.cars c where c.id=t.preferred_car_id and c.status='active') then t.preferred_car_id end);$$);
  execute def;
end;
$migration$;
