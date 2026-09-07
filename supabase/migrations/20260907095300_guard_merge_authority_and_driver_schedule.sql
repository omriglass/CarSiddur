-- Consent never grants a member coordinator-only buffer overrides. Driver claims serialize across cars.
-- REQ §7.3, §8; DATA_MODEL rides/proposals.
create function public.guard_ride_driver_schedule() returns trigger
security definer set search_path=public,pg_temp language plpgsql as $$
begin
  if new.driver_id is null or new.status='cancelled' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('ride-driver:'||new.driver_id::text,0));
  return new;
end $$;
create trigger rides_driver_schedule before insert or update of driver_id,starts_at,ends_at,status on public.rides
  for each row execute function public.guard_ride_driver_schedule();
revoke execute on function public.guard_ride_driver_schedule() from public,anon,authenticated;

do $migration$
declare def text; old_text text;
begin
  def:=pg_get_functiondef('public.claim_ride_driver(uuid,int)'::regprocedure);
  old_text:='  if exists(select 1 from public.rides where driver_id=(select auth.uid())';
  if strpos(def,old_text)=0 then raise exception 'unexpected_driver_claim_check'; end if;
  def:=replace(def,old_text,$$  perform pg_advisory_xact_lock(hashtextextended('ride-driver:'||(select auth.uid())::text,0));
$$||old_text);
  execute def;
  def:=pg_get_functiondef('public.create_proposal(uuid,uuid,public.proposal_type,jsonb,text,uuid[],text)'::regprocedure);
  old_text:='  if p_created_via = ''sadran'' and not public.can_manage_week';
  if strpos(def,old_text)=0 then raise exception 'unexpected_proposal_authorization'; end if;
  def:=replace(def,old_text,$$  if p_created_via is null or p_created_via not in ('sadran','ask_to_join') then raise exception 'not_authorized'; end if;
$$||old_text);
  execute def;
  def:=pg_get_functiondef('public.apply_proposal(uuid)'::regprocedure);
  old_text:=$$      gap_override:=host.turnaround_override_minutes;
      if coalesce((v_prop.payload->>'allow_tight_turnaround')::boolean,false) then$$;
  if strpos(def,old_text)=0 then raise exception 'unexpected_merge_buffer_authorization'; end if;
  def:=replace(def,old_text,$$      gap_override:=case when combined_start=host.starts_at and combined_end=host.ends_at then host.turnaround_override_minutes end;
      if v_prop.created_via='sadran' and coalesce((v_prop.payload->>'allow_tight_turnaround')::boolean,false) then$$);
  execute def;
end;
$migration$;
