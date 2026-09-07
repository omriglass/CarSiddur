-- Sending a second offer requires explicit, current replacement consent from the coordinator.
-- REQ §7.3; DATA_MODEL proposals and optimistic concurrency.
drop function public.send_proposal(uuid,public.notification_channel[]);
create function public.send_proposal(
  p_proposal_id uuid,
  p_sent_via public.notification_channel[] default '{}',
  p_replace_proposal_id uuid default null,
  p_replace_expected_version int default null
) returns jsonb
security definer set search_path=public,pg_temp language plpgsql as $$
declare
  v_prop public.proposals%rowtype;
  v_previous public.proposals%rowtype;
  v_request public.requests%rowtype;
  v_request_id uuid;
  v_token text;
  v_proposal_token text;
  v_party_tokens jsonb:='{}';
  v_party record;
begin
  select request_id into v_request_id from public.proposals where id=p_proposal_id;
  if v_request_id is null then raise exception 'proposal_not_found'; end if;
  -- This order is also used by answer_proposal: request, proposals, then parties.
  select * into v_request from public.requests where id=v_request_id for update;
  perform 1 from public.proposals where request_id=v_request_id order by id for update;
  select * into v_prop from public.proposals where id=p_proposal_id;
  if not public.can_manage_week(v_prop.department_id,v_prop.week_start) and (
    v_prop.created_via<>'ask_to_join' or not public.member_of(v_prop.department_id) or v_request.requester_id<>(select auth.uid())) then
    raise exception 'not_authorized';
  end if;
  if v_prop.status<>'draft' then raise exception 'proposal_not_draft'; end if;
  select * into v_previous from public.proposals where request_id=v_request_id and status='sent';
  if p_replace_proposal_id is null then
    if v_previous.id is not null then raise exception 'proposal_already_sent'; end if;
    if p_replace_expected_version is not null then perform public.raise_stale_version(); end if;
  else
    -- Replacing another person's offer is a coordinator action, even for ask-to-join drafts.
    if not public.can_manage_week(v_prop.department_id,v_prop.week_start) then raise exception 'not_authorized'; end if;
    if v_previous.id is distinct from p_replace_proposal_id or v_previous.version is distinct from p_replace_expected_version
      or v_request.status<>'proposed' then
      perform public.raise_stale_version();
    end if;
    if v_previous.answered_at is not null or exists(select 1 from public.proposal_parties where proposal_id=v_previous.id and response<>'pending') then
      raise exception 'proposal_replacement_answered';
    end if;
  end if;
  perform set_config('app.audit_reason','send_proposal',true);
  perform set_config('app.system_status_transition','on',true);
  if v_previous.id is not null then
    -- Expiring restores the pre-offer request state. Carry it into the replacement,
    -- whose draft may have been created while the request was already proposed.
    update public.proposals set status='expired' where id=v_previous.id;
    v_request.status:=v_previous.previous_status;
  end if;
  v_proposal_token:=public.generate_token();
  update public.proposals set previous_status=v_request.status,
    token_hash=encode(digest(v_proposal_token,'sha256'),'hex'),status='sent',sent_at=now(),sent_via=p_sent_via
    where id=p_proposal_id;
  perform set_config('app.system_status_transition','off',true);
  for v_party in select id,profile_id from public.proposal_parties where proposal_id=p_proposal_id order by id for update loop
    v_token:=public.generate_token();
    update public.proposal_parties set token_hash=encode(digest(v_token,'sha256'),'hex') where id=v_party.id;
    v_party_tokens:=v_party_tokens||jsonb_build_object(v_party.profile_id::text,v_token);
  end loop;
  for v_party in select profile_id from public.proposal_parties where proposal_id=p_proposal_id loop
    perform public.enqueue_notification(v_party.profile_id,'proposal_received',v_prop.department_id,v_prop.week_start,
      jsonb_build_object('newDepart',to_char((v_prop.payload->>'starts_at')::timestamptz at time zone 'Asia/Jerusalem','HH24:MI'),
        'newReturn',to_char((v_prop.payload->>'ends_at')::timestamptz at time zone 'Asia/Jerusalem','HH24:MI')),
      jsonb_build_object('proposal_id',p_proposal_id,'url','/p/'||(v_party_tokens->>v_party.profile_id::text)),
      format('proposal_received:%s:%s',p_proposal_id,v_party.profile_id));
  end loop;
  return jsonb_build_object('proposal_token',v_proposal_token,'party_tokens',v_party_tokens);
end $$;
revoke execute on function public.send_proposal(uuid,public.notification_channel[],uuid,int) from public,anon;
grant execute on function public.send_proposal(uuid,public.notification_channel[],uuid,int) to authenticated;

-- Token answers must recheck state after acquiring the same request lock as sending.
-- Otherwise a token read just before replacement could update its party after expiry.
do $migration$
declare def text:=pg_get_functiondef('public.answer_proposal(text,boolean,text,public.answer_channel)'::regprocedure); old_text text;
begin
  old_text:='  select * into v_proposal from public.proposals where token_hash = v_hash;';
  if strpos(def,old_text)=0 then raise exception 'unexpected_answer_proposal_token_lookup'; end if;
  def:=replace(def,old_text,$$  perform 1 from public.requests q where q.id in (
    select p.request_id from public.proposals p where p.token_hash=v_hash
    union select p.request_id from public.proposal_parties pp join public.proposals p on p.id=pp.proposal_id where pp.token_hash=v_hash
  ) order by q.id for update;
$$||old_text);
  execute def;
  def:=pg_get_functiondef('public.record_answer_on_behalf(uuid,uuid,boolean,text)'::regprocedure);
  old_text:='  select * into v_prop from public.proposals where id = p_proposal_id;';
  if strpos(def,old_text)=0 then raise exception 'unexpected_record_answer_lookup'; end if;
  def:=replace(def,old_text,$$  perform 1 from public.requests q where q.id=(select request_id from public.proposals where id=p_proposal_id) for update;
$$||old_text);
  old_text:=$$response = case when p_accept then 'accepted' else 'declined' end,$$;
  if strpos(def,old_text)=0 then raise exception 'unexpected_record_answer_response_cast'; end if;
  def:=replace(def,old_text,$$response = (case when p_accept then 'accepted' else 'declined' end)::public.party_response,$$);
  execute def;
end;
$migration$;

-- Cron follows the same lock order. Busy requests can expire on the next tick.
create or replace function public.expire_proposals(_now timestamptz default now()) returns int
security definer set search_path=public,pg_temp language plpgsql as $$
declare v_count int:=0; request_row record; r record;
begin
  for request_row in select q.id from public.requests q where exists(
    select 1 from public.proposals p where p.request_id=q.id and p.status='sent' and p.expires_at<=_now
  ) order by q.id for update skip locked loop
    for r in update public.proposals set status='expired'
      where request_id=request_row.id and status='sent' and expires_at<=_now
      returning id,department_id,week_start,request_id,previous_status,created_by loop
      v_count:=v_count+1;
      perform public.enqueue_notification(r.created_by,'proposal_answered',r.department_id,r.week_start,
        jsonb_build_object('answerVerb','expired'),jsonb_build_object('request_id',r.request_id),format('proposal_expired:%s',r.id));
    end loop;
  end loop;
  return v_count;
end $$;
