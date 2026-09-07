-- Member join proposals transition only their own request through the trusted RPC.
-- REQ §7.3; DATA_MODEL proposal status guards.
do $migration$
declare def text:=pg_get_functiondef('public.send_proposal(uuid,public.notification_channel[])'::regprocedure); old_text text;
begin
  old_text:=$$  if v_prop.created_via = 'sadran' and not public.can_manage_week(v_prop.department_id, v_prop.week_start) then$$;
  if strpos(def,old_text)=0 then raise exception 'unexpected_send_proposal_authorization'; end if;
  def:=replace(def,old_text,$$  if not public.can_manage_week(v_prop.department_id,v_prop.week_start) and (
    v_prop.created_via<>'ask_to_join' or not public.member_of(v_prop.department_id) or not exists(
      select 1 from public.requests where id=v_prop.request_id and requester_id=(select auth.uid()))) then$$);
  old_text:='  v_proposal_token := public.generate_token();';
  if strpos(def,old_text)=0 then raise exception 'unexpected_send_proposal_write'; end if;
  def:=replace(def,old_text,$$  perform set_config('app.system_status_transition','on',true);
$$||old_text);
  old_text:='  for v_party in select id, profile_id';
  if strpos(def,old_text)=0 then raise exception 'unexpected_send_proposal_write_end'; end if;
  def:=replace(def,old_text,$$  perform set_config('app.system_status_transition','off',true);
$$||old_text);
  execute def;
end;
$migration$;
