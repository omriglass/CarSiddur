-- Owner 2026-10-23 (notification noise): moving a request on the board while its offer is out sent the member a new
-- offer each time (7 offers for one ride in 25 minutes), and every drag out and back in left one more held "update".
--   1. A new offer on the same request replaces the person's earlier offer notices (the inbox keeps only the latest)
--      and pushes nothing while none of them was opened by the member.
--   2. An offer's notice that the system clears when the offer ends is tagged `cleared_by: system`, so "read" keeps
--      meaning "the member opened it".
--   3. A held board update about a ride the person had just been put on is dropped when that ride is cancelled or
--      deleted before sending (flush_held_notices would send nothing for it anyway; the Send All count shows it).

-- The guard keeps a notification's content fixed; the only data change it allows is that system tag.
create or replace function public.notifications_protect_fields()
 returns trigger
 language plpgsql
as $$
begin
  if new.title_he is distinct from old.title_he or new.body_he is distinct from old.body_he
     or new.event is distinct from old.event
     or (new.data is distinct from old.data and new.data is distinct from coalesce(old.data, '{}'::jsonb) || jsonb_build_object('cleared_by', 'system'))
     or new.dedupe_key is distinct from old.dedupe_key or new.recipient_id is distinct from old.recipient_id then
    raise exception 'notification_fields_locked' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create or replace function public.proposals_clear_inbox()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $$
begin
  update public.notifications set read_at = now(), data = coalesce(data, '{}'::jsonb) || jsonb_build_object('cleared_by', 'system')
  where event = 'proposal_received' and read_at is null and data ->> 'proposal_id' = new.id::text;
  return new;
end $$;

create or replace function public.send_proposal(p_proposal_id uuid, p_sent_via public.notification_channel[] default '{}'::public.notification_channel[], p_replace_proposal_id uuid default null::uuid, p_replace_expected_version integer default null::integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $$
declare
  v_prop public.proposals%rowtype;
  v_previous public.proposals%rowtype;
  v_request public.requests%rowtype;
  v_request_id uuid;
  v_token text;
  v_proposal_token text;
  v_party_tokens jsonb:='{}';
  v_party record;
  v_reader jsonb; v_check jsonb; v_h record; v_leg_txt text; v_ext boolean := false;
  v_old_notices uuid[]; v_quiet boolean; v_notification uuid;
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
  -- REQ §13.111 (a): a Sadran draft that waives the large trunk is re-checked "as allowed".
  if v_prop.created_via='sadran' and coalesce((v_prop.payload->>'allow_small_trunk')::boolean,false) then perform public._small_trunk_mode(true); end if;
  -- Owner decision (20260910098000): the day may have gone public between draft and send
  -- (create_proposal() guards at creation time, but a draft sitting unsent is never touched
  -- by expire_proposals(), which only expires status='sent' rows) — re-check at send time.
  -- Same ask to join exemption as create_proposal().
  if v_prop.created_via <> 'ask_to_join' and v_prop.type not in ('shift','merge')
     and public.is_day_public(v_prop.department_id, v_prop.week_start,
       (coalesce(v_request.depart_at, v_request.return_at) at time zone 'Asia/Jerusalem')::date)
  then
    raise exception 'proposal_day_public' using errcode = 'P0001';
  end if;
  if v_prop.type='merge' and exists(select 1 from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) l
       left join public.rides r on r.id=(l->>'ride_id')::uuid where r.id is null or r.status='cancelled') then
    raise exception 'ride_not_found' using errcode='P0001';
  end if;
  -- REQ §13.102 R2B13: a merge that no longer holds (the member is already on the ride for those legs, a seat or
  -- detour limit now fails) is refused at send time, so the same merge is never sent twice.
  if v_prop.type='merge' then
    for v_h in select distinct (l->>'ride_id')::uuid as ride_id from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) l loop
      select case when count(distinct coalesce(l->>'leg','both'))>1 or bool_or(coalesce(l->>'leg','both')='both') then 'both'
                  else max(coalesce(l->>'leg','both')) end into v_leg_txt
      from jsonb_array_elements(coalesce(v_prop.payload->'legs','[]')) l
      where (l->>'ride_id')::uuid=v_h.ride_id and coalesce(l->>'role','passenger')<>'driver';
      if v_leg_txt is not null then
        v_check:=public._merge_check(v_h.ride_id,v_request.id,v_leg_txt::public.ride_leg);
        if not (v_check->>'ok')::boolean then raise exception '%',v_check->>'error' using errcode='P0001'; end if;
        -- R7B3: the same turnaround rule as create_proposal / apply_proposal (only an explicit consented window may be tight).
        if coalesce((v_check->>'turnaround_conflict')::boolean,false)
           and not (coalesce((v_prop.payload->>'window_explicit')::boolean,false) and coalesce((v_prop.payload->>'allow_tight_turnaround')::boolean,false)) then
          raise exception 'merge_turnaround_conflict' using errcode='P0001';
        end if;
      end if;
    end loop;
  end if;
  -- R5B3 (QA run 13 re-check, 2026-10-23): a Sadran shift that names a car is tried now (applied and rolled back), so a
  -- car that cannot take it — elsewhere at that time, too small, busy — is refused here with the reason, instead of
  -- the member accepting and the proposal being withdrawn as stale afterwards (several notices, nothing placed).
  -- ("כבר סיכמנו" — agree_proposal_offline — applies right after sending and handles a failure itself.)
  if v_prop.type='shift' and v_prop.created_via='sadran' and v_prop.payload ? 'car_id'
     and coalesce(current_setting('app.defer_proposal_apply', true), '') <> 'on' then
    v_leg_txt := public._proposal_apply_trial(v_prop.id);
    if v_leg_txt is not null then raise exception '%', v_leg_txt using errcode='P0001'; end if;
  end if;
  select * into v_previous from public.proposals where request_id=v_request_id and status='sent';
  -- REQ §13.103 R3B11: a Sadran merge draft that extends the sent merge (the other leg of a split merge) replaces it
  -- itself: no replacement arguments needed (a stale board version is no conflict), the old one is withdrawn.
  v_ext := v_prop.type='merge' and v_prop.created_via='sadran' and v_previous.id is not null
    and v_prop.payload->>'extends_proposal_id' = v_previous.id::text;
  if v_ext then
    if v_previous.answered_at is not null or exists(select 1 from public.proposal_parties where proposal_id=v_previous.id and response<>'pending') then
      raise exception 'proposal_replacement_answered';
    end if;
  elsif p_replace_proposal_id is null then
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
    update public.proposals set status=case when v_ext then 'withdrawn' else 'expired' end::public.proposal_status where id=v_previous.id;
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
    -- REQ §13.101 b: one text per reader (variant + old -> new variables), never the whole WhatsApp text.
    v_reader:=public.proposal_reader_vars(p_proposal_id,v_party.profile_id);
    -- Owner 2026-10-23 (notification noise): a new offer on the same request replaces this person's earlier offer
    -- notices - the inbox keeps only the latest - and is quiet (no push) while none of them was opened. "Opened" =
    -- read by the member, not cleared by the system when the offer ended (proposals_clear_inbox tags that).
    select array_agg(n.id),
           bool_and(n.read_at is null or coalesce(n.data->>'cleared_by','')='system')
      into v_old_notices, v_quiet
    from public.notifications n
    join public.proposals op on op.id::text=n.data->>'proposal_id'
    where n.recipient_id=v_party.profile_id and n.event='proposal_received'
      and op.request_id=v_prop.request_id and op.id<>p_proposal_id;
    if v_old_notices is not null then
      delete from public.notifications where id=any(v_old_notices);
    end if;
    v_notification:=public.enqueue_notification(v_party.profile_id,'proposal_received',v_prop.department_id,v_prop.week_start,
      coalesce(v_reader->'vars','{}'::jsonb),
      jsonb_build_object('proposal_id',p_proposal_id,'url','/p/'||(v_party_tokens->>v_party.profile_id::text),'variant',v_reader->>'variant'),
      format('proposal_received:%s:%s',p_proposal_id,v_party.profile_id));
    if coalesce(v_quiet,false) and v_notification is not null then
      delete from public.push_outbox where notification_id=v_notification;
    end if;
  end loop;
  -- QA run 10 (R10B6 / R10F1): informational only — the board has already shown the warning and the Sadran confirmed.
  return jsonb_build_object('proposal_token',v_proposal_token,'party_tokens',v_party_tokens,
    'car_conflicts',public._proposal_car_conflicts(p_proposal_id));
end $$;


ALTER FUNCTION "public"."send_proposal"("p_proposal_id" "uuid", "p_sent_via" "public"."notification_channel"[], "p_replace_proposal_id" "uuid", "p_replace_expected_version" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."send_test_notification"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_me uuid := (select auth.uid());
  v_devices int;
begin
  if v_me is null or not public.is_approved() then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  select count(*) into v_devices from public.push_subscriptions where profile_id = v_me;
  perform public.enqueue_notification(
    v_me, 'test_notification', (select default_department_id from public.profiles where id = v_me), null,
    '{}'::jsonb, '{}'::jsonb, format('test_notification:%s:%s', v_me, clock_timestamp()));
  return jsonb_build_object('devices', v_devices);
end;
$$;

create or replace function public.rides_drop_held_joins()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $$
declare v_ride uuid := case when tg_op = 'DELETE' then old.id else new.id end;
begin
  delete from public.held_notices h
  where h.subject_kind = 'ride' and h.subject_id = v_ride
    and (select f.change_kind from public.held_notices f
         where f.recipient_id = h.recipient_id and f.subject_kind = 'ride' and f.subject_id = v_ride
         order by f.seq limit 1) = 'joins';
  return null;
end $$;

revoke all on function public.rides_drop_held_joins() from public;

create trigger rides_drop_held_joins_cancel after update of status on public.rides
  for each row when (new.status = 'cancelled' and old.status is distinct from new.status)
  execute function public.rides_drop_held_joins();
create trigger rides_drop_held_joins_delete after delete on public.rides
  for each row execute function public.rides_drop_held_joins();
