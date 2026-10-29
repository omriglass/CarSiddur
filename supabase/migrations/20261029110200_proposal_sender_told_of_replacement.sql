-- RC1B4/RC1B5 (QA concurrency run 1, owner 2026-10-29): with two Sadranim on one week, the Sadran who sent an offer
-- was not told when (a) the other Sadran's offer for the same request replaced it, or (b) it was withdrawn after the
-- members accepted - only the offer's creator and this week's rotating Sadran (sadranim_of) were. Proposals now record
-- who sent them; send_proposal tells the replaced offer's creator and sender (new proposal_answered variant
-- replaced_by_other). Full definition of send_proposal from schema-current.sql plus those two changes.

alter table public.proposals add column sent_by uuid references public.profiles(id) on delete set null;
comment on column public.proposals.sent_by is 'Who sent the proposal (send_proposal); told when it is replaced or withdrawn.';
create index proposals_sent_by_idx on public.proposals (sent_by) where sent_by is not null;

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'proposal_answered'::public.notification_event, ch.channel::public.notification_channel, 'replaced_by_other',
  'ההצעה ל{{firstName}} הוחלפה', '{{destination}}, יום {{day}} — {{byName}} שלח/ה הצעה אחרת במקומה',
  'ההצעה ל{{firstName}} הוחלפה', '{{destination}}, יום {{day}} — {{byName}} שלח/ה הצעה אחרת במקומה'
from (values ('inbox'), ('push')) as ch(channel)
on conflict (event, channel, (coalesce(variant, ''))) do update
  set title = excluded.title, body = excluded.body, default_title = excluded.default_title,
      default_body = excluded.default_body, updated_at = now();

CREATE OR REPLACE FUNCTION "public"."send_proposal"("p_proposal_id" "uuid", "p_sent_via" "public"."notification_channel"[] DEFAULT '{}'::"public"."notification_channel"[], "p_replace_proposal_id" "uuid" DEFAULT NULL::"uuid", "p_replace_expected_version" integer DEFAULT NULL::integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
  v_old_notices uuid[]; v_quiet boolean; v_notification uuid; v_ended_quiet boolean;
  v_to uuid; v_by text;
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
    -- RC1B4: two Sadranim on one week - whoever created or sent the replaced offer is told who replaced it (the
    -- replacing Sadran is not told about their own change).
    if v_previous.created_via = 'sadran' then
      select full_name into v_by from public.profiles where id = (select auth.uid());
      for v_to in
        select distinct x from (values (v_previous.created_by), (v_previous.sent_by)) s(x)
        where x is not null and x is distinct from (select auth.uid())
      loop
        perform public.enqueue_notification(v_to, 'proposal_answered', v_prop.department_id, v_prop.week_start,
          jsonb_build_object('byName', coalesce(v_by, '')),
          jsonb_build_object('variant', 'replaced_by_other', 'proposal_id', v_previous.id, 'request_id', v_request_id),
          format('proposal_replaced:%s:%s', v_previous.id, v_to));
      end loop;
    end if;
  end if;
  v_proposal_token:=public.generate_token();
  update public.proposals set previous_status=v_request.status,
    token_hash=encode(digest(v_proposal_token,'sha256'),'hex'),status='sent',sent_at=now(),sent_via=p_sent_via,
    sent_by=(select auth.uid())
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
    -- O28-3: an earlier offer that ended (withdrawn / expired, also the one replaced just above) already left the inbox;
    -- its party row remembers whether this person had opened it. The latest such offer counts like a notice still there.
    select not pp.offer_notice_opened into v_ended_quiet
    from public.proposal_parties pp
    join public.proposals op on op.id=pp.proposal_id
    where pp.profile_id=v_party.profile_id and pp.offer_notice_opened is not null
      and op.request_id=v_prop.request_id and op.id<>p_proposal_id
    order by op.sent_at desc nulls last, op.id desc
    limit 1;
    v_quiet := case when v_ended_quiet is null then v_quiet when v_quiet is null then v_ended_quiet
                    else v_quiet and v_ended_quiet end;
    if v_old_notices is not null then
      delete from public.notifications where id=any(v_old_notices);
    end if;
    -- The ended offers just weighed are now folded into this one, as their notices would have been: the next offer
    -- is judged by this one alone (20261029102600).
    update public.proposal_parties pp set offer_notice_opened = null
    from public.proposals op
    where op.id=pp.proposal_id and pp.profile_id=v_party.profile_id and pp.offer_notice_opened is not null
      and op.request_id=v_prop.request_id and op.id<>p_proposal_id;
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

