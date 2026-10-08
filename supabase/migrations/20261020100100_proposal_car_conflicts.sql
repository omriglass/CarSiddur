-- QA run 10 (REQ §13.112 e, R10B6 / R10F1): a proposal whose car another pending proposal already holds at an overlapping
-- time is NOT refused — the board warns the Sadran, who may send anyway (an answer stands, REQ §13.102; the later acceptance is
-- withdrawn as stale if the car is really taken). `proposal_car_conflicts(proposal)` is the preview (any draft or sent proposal of a
-- week the caller manages); `send_proposal` repeats the same list as `car_conflicts` in its result (empty array = none).
-- "Pending" = sent, or accepted and not yet applied. Held = the car and window the payload names: a plan B's outbound
-- (car_id, depart_at..arrive_by) and pickup (return_car_id or car_id, around pickup_at/return_at), a shift/origin proposal's
-- (car_id, depart_at..return_at, two hours when open-ended). A merge holds no car of its own (it joins a ride).
create or replace function public._proposal_car_holds(p_payload jsonb, p_type public.proposal_type)
returns table (car_id uuid, from_at timestamptz, to_at timestamptz)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare v_dep timestamptz; v_arr timestamptz; v_pick timestamptz; v_ret timestamptz; v_dur interval; v_car uuid; v_ret_car uuid;
begin
  v_car := nullif(p_payload ->> 'car_id', '')::uuid;
  if v_car is null then return; end if;
  v_dep := nullif(p_payload ->> 'depart_at', '')::timestamptz;
  v_ret := nullif(p_payload ->> 'return_at', '')::timestamptz;
  if p_type = 'alternative' then
    v_arr := nullif(p_payload ->> 'arrive_by', '')::timestamptz;
    if v_dep is null or v_arr is null then return; end if;
    v_dur := greatest(v_arr - v_dep, interval '15 minutes');
    car_id := v_car; from_at := v_dep; to_at := v_arr; return next;
    v_pick := nullif(p_payload ->> 'pickup_at', '')::timestamptz;
    if coalesce((p_payload ->> 'pickup')::boolean, false) and v_pick is not null then
      v_ret_car := coalesce(nullif(p_payload ->> 'return_car_id', '')::uuid, v_car);
      car_id := v_ret_car; from_at := least(v_pick, coalesce(v_ret, v_pick)); to_at := greatest(v_pick, coalesce(v_ret, v_pick)) + v_dur; return next;
    end if;
  elsif p_type in ('shift', 'origin') then
    if coalesce(v_dep, v_ret) is null then return; end if;
    car_id := v_car; from_at := coalesce(v_dep, v_ret); to_at := coalesce(v_ret, v_dep + interval '2 hours'); return next;
  end if;
end $$;
alter function public._proposal_car_holds(jsonb, public.proposal_type) owner to postgres;
revoke all on function public._proposal_car_holds(jsonb, public.proposal_type) from public;
grant execute on function public._proposal_car_holds(jsonb, public.proposal_type) to service_role;

create or replace function public._proposal_car_conflicts(p_proposal_id uuid)
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'proposal_id', o.id, 'request_id', o.request_id, 'type', o.type, 'status', o.status,
      'requester_name', coalesce(pf.full_name, ''), 'car_id', h.car_id, 'car_name', coalesce(c.name, ''),
      'from_at', greatest(h.from_at, mine.from_at), 'to_at', least(h.to_at, mine.to_at))
    order by greatest(h.from_at, mine.from_at), o.id), '[]'::jsonb)
  from public.proposals p
  cross join lateral public._proposal_car_holds(p.payload, p.type) mine
  join public.proposals o on o.department_id = p.department_id and o.week_start = p.week_start and o.id <> p.id
    and o.request_id <> p.request_id and (o.status = 'sent' or o.status = 'accepted')
  cross join lateral public._proposal_car_holds(o.payload, o.type) h
  left join public.requests q on q.id = o.request_id
  left join public.profiles pf on pf.id = q.requester_id
  left join public.cars c on c.id = h.car_id
  where p.id = p_proposal_id and h.car_id = mine.car_id and h.from_at < mine.to_at and mine.from_at < h.to_at
$$;
alter function public._proposal_car_conflicts(uuid) owner to postgres;
revoke all on function public._proposal_car_conflicts(uuid) from public;
grant execute on function public._proposal_car_conflicts(uuid) to service_role;

create or replace function public.proposal_car_conflicts(p_proposal_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare v_dept uuid; v_week date;
begin
  select department_id, week_start into v_dept, v_week from public.proposals where id = p_proposal_id;
  if v_dept is null then raise exception 'proposal_not_found'; end if;
  if not public.can_manage_week(v_dept, v_week) then raise exception 'not_authorized'; end if;
  return public._proposal_car_conflicts(p_proposal_id);
end $$;
alter function public.proposal_car_conflicts(uuid) owner to postgres;
revoke all on function public.proposal_car_conflicts(uuid) from public;
grant execute on function public.proposal_car_conflicts(uuid) to authenticated;
grant execute on function public.proposal_car_conflicts(uuid) to service_role;

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
    perform public.enqueue_notification(v_party.profile_id,'proposal_received',v_prop.department_id,v_prop.week_start,
      coalesce(v_reader->'vars','{}'::jsonb),
      jsonb_build_object('proposal_id',p_proposal_id,'url','/p/'||(v_party_tokens->>v_party.profile_id::text),'variant',v_reader->>'variant'),
      format('proposal_received:%s:%s',p_proposal_id,v_party.profile_id));
  end loop;
  -- QA run 10 (R10B6 / R10F1): informational only — the board has already shown the warning and the Sadran confirmed.
  return jsonb_build_object('proposal_token',v_proposal_token,'party_tokens',v_party_tokens,
    'car_conflicts',public._proposal_car_conflicts(p_proposal_id));
end $$;


ALTER FUNCTION "public"."send_proposal"("p_proposal_id" "uuid", "p_sent_via" "public"."notification_channel"[], "p_replace_proposal_id" "uuid", "p_replace_expected_version" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_freed_slot_opt_out"("p_request_id" "uuid", "p_opt_out" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_req record;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if v_req.requester_id <> (select auth.uid()) and not public.can_manage_week(v_req.department_id, v_req.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;

  perform set_config('app.audit_reason', 'set_freed_slot_opt_out', true);
  update public.requests set freed_slot_opt_out = p_opt_out where id = p_request_id;
end;
$$;

