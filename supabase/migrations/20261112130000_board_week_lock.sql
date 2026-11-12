-- PF1 B3 / DD1 (docs/PF1_PLAN_2026-11.md §4; docs/TODO.md PF1 causes 2-3, DD1).
-- On the slow evening of 2026-11-11 the board's proposal writes ran several times at once: five identical drafts in
-- one second, "send all" twice, and writers taking row locks in different orders (deadlocks).
--  * `_board_week_lock(dept, week)`: a transaction-level advisory lock. The board's proposal RPCs take it first,
--    before any row lock, so two of them never interleave. Only top-level board calls take it — a call from inside
--    another writer (ask-to-join inside `submit_request`) does not, since waiting there with row locks held could
--    itself deadlock.
--  * `create_proposal`: an identical open Sadran draft is returned instead of filed again.
-- Function bodies are otherwise unchanged from the previous definitions.

create or replace function public._board_week_lock(p_department_id uuid, p_week_start date) returns void
  language sql security definer set search_path = public, pg_temp
as $$
  select pg_advisory_xact_lock(hashtextextended('board_week:' || p_department_id::text || ':' || p_week_start::text, 0));
$$;
revoke all on function public._board_week_lock(uuid, date) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION "public"."create_proposal"("p_request_id" "uuid", "p_ride_id" "uuid", "p_type" "public"."proposal_type", "p_payload" "jsonb", "p_reason_he" "text", "p_party_profile_ids" "uuid"[] DEFAULT '{}'::"uuid"[], "p_created_via" "text" DEFAULT 'sadran'::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_req record;
  v_proposal_id uuid;
  v_token text;
  v_party uuid;
  host public.rides%rowtype;
  target_ids uuid[];
  required_parties uuid[];
  host_versions jsonb:='{}'; host_snapshots jsonb:='{}';
  source_versions jsonb:='{}'; source_snapshots jsonb:='{}';
  combined_start timestamptz;combined_end timestamptz;
  v_leg_txt text; v_check jsonb;
  v_explicit boolean := false; v_old_draft public.proposals%rowtype; v_union jsonb;
  v_orig_targets int; v_new_legs jsonb; v_e jsonb; v_h_leg public.ride_leg; v_p_ride uuid; v_p_leg public.ride_leg; v_host_car uuid;
  v_allow boolean := false;
begin
  select * into v_req from public.requests where id = p_request_id;
  if v_req is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  -- PF1 B3: board writes of one department week run one at a time; the request is read again under the lock.
  if p_created_via = 'sadran' then
    perform public._board_week_lock(v_req.department_id, v_req.week_start);
    select * into v_req from public.requests where id = p_request_id;
  end if;

  if p_created_via is null or p_created_via not in ('sadran','ask_to_join') then raise exception 'not_authorized'; end if;
  if p_created_via = 'sadran' and not public.can_manage_week(v_req.department_id, v_req.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  elsif p_created_via = 'ask_to_join' and v_req.requester_id <> (select auth.uid())
        and not public.can_manage_week(v_req.department_id, v_req.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  -- REQ §13.111 (a): only a Sadran draft may carry `allow_small_trunk` (the large-trunk requirement waived by hand);
  -- it is kept in the payload so send and apply honour it, and the merge/series probes below run "as allowed".
  if p_created_via <> 'sadran' then
    p_payload := coalesce(p_payload, '{}'::jsonb) - 'allow_small_trunk' - 'allow_long_detour';
  else
    v_allow := coalesce((p_payload ->> 'allow_small_trunk')::boolean, false);
    if v_allow then perform public._small_trunk_mode(true); end if;
    -- REQ §13.175 (a): the Sadran's "לאחד בכל זאת" for a long detour, honoured the same way on send and apply.
    perform public._long_detour_mode(coalesce((p_payload ->> 'allow_long_detour')::boolean, false));
    if p_type = 'shift' and nullif(p_payload ->> 'car_id', '') is not null then
      perform public._small_trunk_check(array[v_req.id], (p_payload ->> 'car_id')::uuid, v_allow);
    end if;
  end if;
  -- REQ §13.99: the Sadran never places/merges a request onto a private car (ask-to-join to the owner stays).
  if p_created_via = 'sadran' then
    if p_type = 'merge' then
      for v_host_car in select distinct rd.car_id from public.rides rd
        where rd.id in (select (l->>'ride_id')::uuid from jsonb_array_elements(coalesce(p_payload->'legs','[]')) l) loop
        perform public.assert_private_car_owner_only(v_host_car, (select auth.uid()), v_req.requester_id);
      end loop;
    elsif p_type in ('shift','origin','alternative') and nullif(p_payload->>'car_id','') is not null then
      perform public.assert_private_car_owner_only((p_payload->>'car_id')::uuid, (select auth.uid()), v_req.requester_id);
      if p_type = 'alternative' and nullif(p_payload->>'return_car_id','') is not null then
        perform public.assert_private_car_owner_only((p_payload->>'return_car_id')::uuid, (select auth.uid()), v_req.requester_id);
      end if;
    end if;
  end if;

  -- Owner decision (20260910098000): a proposal cannot be created for a day that is
  -- already published — that day's coordination happens directly, not through the app.
  -- Ask to join is exempt: it is filed by submit_request(), not composed by the Sadran,
  -- and still needs to reach the temporary car's owner even on a published/live day.
  -- REQ §13.100 b: the Sadran may still create shift and merge proposals on a published day.
  if p_created_via <> 'ask_to_join' and p_type not in ('shift','merge')
     and public.is_day_public(v_req.department_id, v_req.week_start,
       (coalesce(v_req.depart_at, v_req.return_at) at time zone 'Asia/Jerusalem')::date)
  then
    raise exception 'proposal_day_public' using errcode = 'P0001';
  end if;

  if p_type='merge' then
    -- REQ §13.102 R2M2: a second Sadran merge draft for the request extends the open one (a leg already
    -- drafted keeps its place unless the new draft covers the same slot), instead of silently replacing it.
    -- R2B2: the payload window is only ever an explicit expansion request, never a default copy of the host's.
    v_explicit := (p_payload ? 'starts_at' or p_payload ? 'ends_at');
    if p_created_via='sadran' then
      -- REQ §13.103 R3B11: the open merge is the draft, or the sent one nobody has answered yet (the board sends a
      -- leg's merge straight away); the new draft then carries `extends_proposal_id` and send_proposal replaces it.
      select * into v_old_draft from public.proposals pr
      where pr.request_id=p_request_id and pr.created_via='sadran' and pr.type='merge'
        and (pr.status='draft' or (pr.status='sent' and pr.answered_at is null
             and not exists(select 1 from public.proposal_parties pp where pp.proposal_id=pr.id and pp.response<>'pending')))
      order by (pr.status='draft') desc, pr.created_at desc limit 1;
      if v_old_draft.id is not null then
        v_union:=public._merge_union_legs(v_old_draft.payload->'legs',p_payload->'legs');
        p_payload:=jsonb_set(p_payload,'{legs}',v_union);
        if v_old_draft.status='sent' then
          p_payload:=p_payload||jsonb_build_object('extends_proposal_id',v_old_draft.id);
        elsif v_old_draft.payload ? 'extends_proposal_id' then
          p_payload:=p_payload||jsonb_build_object('extends_proposal_id',v_old_draft.payload->'extends_proposal_id');
        end if;
      end if;
    end if;
    select array_agg(distinct (leg->>'ride_id')::uuid) into target_ids from jsonb_array_elements(coalesce(p_payload->'legs','[]')) leg;
    if coalesce(cardinality(target_ids),0)=0 then raise exception 'merge_target_required'; end if;
    v_orig_targets:=cardinality(target_ids);
    -- REQ §13.100 QB3: a both ways join into a connected drop-off pair rides each leg on its own ride.
    v_new_legs:='[]'::jsonb;
    for v_e in select value from jsonb_array_elements(p_payload->'legs') loop
      v_h_leg:=null; v_p_ride:=null; v_p_leg:=null;
      if coalesce(v_e->>'leg','both')='both' and coalesce(v_e->>'role','passenger')<>'driver' then
        select rr_h.leg, rr_p.ride_id, rr_p.leg into v_h_leg, v_p_ride, v_p_leg
        from public.ride_requests rr_h
        join public.rides h on h.id=rr_h.ride_id
        join public.ride_requests rr_p on rr_p.request_id=rr_h.request_id and rr_p.car_mode='relay'
          and rr_p.leg=(case when rr_h.leg='out' then 'return' else 'out' end)::public.ride_leg
        join public.rides rp on rp.id=rr_p.ride_id and rp.car_id=h.car_id and rp.status<>'cancelled' and rp.id<>h.id
        where rr_h.ride_id=(v_e->>'ride_id')::uuid and rr_h.car_mode='relay' and rr_h.leg in ('out','return')
        order by rr_h.leg limit 1;
      end if;
      if v_p_ride is not null then
        v_new_legs:=v_new_legs||jsonb_build_array(v_e||jsonb_build_object('leg',v_h_leg::text),
                                                  v_e||jsonb_build_object('ride_id',v_p_ride,'leg',v_p_leg::text));
      else
        v_new_legs:=v_new_legs||jsonb_build_array(v_e);
      end if;
    end loop;
    p_payload:=jsonb_set(p_payload,'{legs}',v_new_legs);
    select array_agg(distinct (leg->>'ride_id')::uuid) into target_ids from jsonb_array_elements(p_payload->'legs') leg;
    if cardinality(target_ids)>v_orig_targets then p_payload:=p_payload-'starts_at'-'ends_at'; v_explicit:=false; end if;
    if v_orig_targets>1 and (p_payload ? 'starts_at' or p_payload ? 'ends_at') then raise exception 'merge_single_expanded_target_required'; end if;
    required_parties:=array[v_req.requester_id];
    for host in select * from public.rides where id=any(target_ids) order by id for update loop
      if host.department_id<>v_req.department_id or host.week_start<>v_req.week_start then raise exception 'not_authorized'; end if;
      -- A host ride cancelled meanwhile (another Sadran) is gone, not forbidden (hardening 2026-10-29).
      if host.status='cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
      combined_start:=least(host.starts_at,coalesce((p_payload->>'starts_at')::timestamptz,host.starts_at));
      combined_end:=greatest(host.ends_at,coalesce((p_payload->>'ends_at')::timestamptz,host.ends_at));
      if not public.is_quarter_hour(combined_start)
        or not (public.is_quarter_hour(combined_end) or (combined_end at time zone 'Asia/Jerusalem')::time=time '23:59')
        or combined_end<=combined_start
        or (combined_end at time zone 'Asia/Jerusalem')::date<>(combined_start at time zone 'Asia/Jerusalem')::date
        or (combined_start at time zone 'Asia/Jerusalem')::date<>(host.starts_at at time zone 'Asia/Jerusalem')::date
        or (combined_start at time zone 'Asia/Jerusalem')::date<>(coalesce(v_req.depart_at,v_req.return_at) at time zone 'Asia/Jerusalem')::date then raise exception 'ride_request_day_mismatch'; end if;
      -- REQ §13.95 H1: boarding before the base ride's end, detour within the limits (the ride's own
      -- window moves at apply time; skipped when the request joins as the ride's driver).
      select case when count(distinct coalesce(l->>'leg','both'))>1 or bool_or(coalesce(l->>'leg','both')='both') then 'both'
                  else max(coalesce(l->>'leg','both')) end into v_leg_txt
      from jsonb_array_elements(coalesce(p_payload->'legs','[]')) l where (l->>'ride_id')::uuid=host.id and coalesce(l->>'role','passenger')<>'driver';
      if v_leg_txt is not null then
        v_check:=public._merge_check(host.id,v_req.id,v_leg_txt::public.ride_leg);
        if not (v_check->>'ok')::boolean then
          -- REQ §13.111 (a): the Sadran's draft refuses a luggage-only problem with the waivable code (a member's
          -- ask-to-join keeps the plain merge refusal - only the Sadran waives).
          if v_check->>'error'='merge_luggage_needs_large_trunk' and p_created_via='sadran' then
            raise exception 'needs_large_trunk' using errcode='P0001', detail=public._small_trunk_detail_for(array[v_req.id],host.car_id,host.id);
          end if;
          raise exception '%',v_check->>'error' using errcode='P0001';
        end if;
        -- R2B2: growing the ride must not silently eat the car's turnaround; only an explicit window may.
        if coalesce((v_check->>'turnaround_conflict')::boolean,false)
           and not (v_explicit and public.can_manage_week(v_req.department_id,v_req.week_start)) then
          raise exception 'merge_turnaround_conflict' using errcode='P0001';
        end if;
      end if;
      host_versions:=host_versions||jsonb_build_object(host.id::text,host.version);
      host_snapshots:=host_snapshots||jsonb_build_object(host.id::text,jsonb_build_object('fp',public.ride_merge_fingerprint(host.id)));
      required_parties:=required_parties||array[host.driver_id]||array(select q.requester_id from public.ride_requests rr join public.requests q on q.id=rr.request_id where rr.ride_id=host.id);
    end loop;
    if (select count(*) from jsonb_object_keys(host_versions))<>cardinality(target_ids) then raise exception 'ride_not_found'; end if;
    select coalesce(jsonb_object_agg(r.id::text,r.version),'{}'),
           coalesce(jsonb_object_agg(r.id::text,jsonb_build_object('fp',public.ride_merge_fingerprint(r.id))),'{}')
      into source_versions,source_snapshots from public.rides r join public.ride_requests rr on rr.ride_id=r.id
      where rr.request_id=v_req.id and r.status<>'cancelled' and not(r.id=any(target_ids));
    select array_agg(distinct id) into p_party_profile_ids from unnest(coalesce(p_party_profile_ids,'{}')||required_parties) id where id is not null;
    p_payload:=p_payload||jsonb_build_object('host_versions',host_versions,'host_snapshots',host_snapshots,'source_versions',source_versions,'source_snapshots',source_snapshots,
      'window_explicit',v_explicit,
      'request_fingerprint',public.merge_request_fingerprint(v_req.id),'allow_tight_turnaround',v_explicit and public.can_manage_week(v_req.department_id,v_req.week_start));
  elsif p_type='shift' and p_payload ? 'series_span' then
    -- REQ §13.101 j: fewer days for a multi-day request (series head, one car, consecutive sub-span).
    if p_created_via<>'sadran' then raise exception 'not_authorized' using errcode='P0001'; end if;
    if nullif(p_payload->>'car_id','') is null or jsonb_typeof(p_payload->'series_span')<>'object'
       or p_payload ? 'depart_at' or p_payload ? 'return_at' or p_payload ? 'origin_id' or p_payload ? 'origin_text'
       or p_payload ? 'destination_id' or p_payload ? 'destination_text' or p_payload ? 'stops' then
      raise exception 'series_span_invalid' using errcode='P0001';
    end if;
    if v_req.series_id is null or v_req.series_index is distinct from 1 then
      raise exception 'series_span_requires_series_head' using errcode='P0001';
    end if;
    -- Feasibility probe: run the real change inside a sub-block that always rolls back.
    begin
      perform public._apply_series_span(v_req.id,p_payload->'series_span',(p_payload->>'car_id')::uuid);
      raise exception 'series_span_probe_ok' using errcode='P0001';
    exception when others then
      if sqlerrm<>'series_span_probe_ok' then raise; end if;
    end;
  elsif p_type='shift' and v_req.series_id is not null and p_payload->>'ride_id' is null
        and (p_payload ? 'depart_at' or p_payload ? 'return_at') then
    -- R13B6: new times for a multi-day request move the whole span (`series_span` on the head, above); a plain
    -- one-day shift would place day 1 only and leave the other days waiting.
    raise exception 'series_edit_not_supported' using errcode='MDR02';
  elsif p_type='shift' and (p_payload ? 'origin_id' or p_payload ? 'origin_text' or p_payload ? 'destination_id'
        or p_payload ? 'destination_text' or p_payload ? 'stops') then
    perform public._assert_shift_places(v_req.id, v_req.department_id, p_payload);
  elsif p_type='origin' then
    if p_created_via <> 'sadran' then raise exception 'not_authorized' using errcode = 'P0001'; end if;
    if nullif(p_payload->>'origin_id','') is null or nullif(p_payload->>'car_id','') is null then
      raise exception 'origin_proposal_requires_car_and_origin' using errcode = 'P0001';
    end if;
  elsif p_type='alternative' then
    if p_created_via <> 'sadran' then raise exception 'not_authorized' using errcode = 'P0001'; end if;
    p_payload := public._validate_alternative_payload(v_req.id, p_payload);
  end if;

  -- No timer any more: expires_at stays null until the proposal's day is
  -- published or has passed (expire_proposals(), 20260910090000, decides that).
  -- REQ §13.94 (board drafts): one open draft per request. A new Sadran draft supersedes the
  -- older one (it becomes `withdrawn`; the status guard leaves the request alone for drafts).
  -- DD1: the same draft asked for again (a repeated tap while the app is slow) is the draft that already exists.
  if p_created_via = 'sadran' then
    select pr.id into v_proposal_id from public.proposals pr
    where pr.request_id = p_request_id and pr.status = 'draft' and pr.created_via = 'sadran' and pr.type = p_type
      and pr.ride_id is not distinct from p_ride_id and pr.payload = p_payload
      and pr.reason_he is not distinct from p_reason_he and pr.created_by = (select auth.uid())
    order by pr.created_at desc, pr.id limit 1;
    if v_proposal_id is not null then return v_proposal_id; end if;
  end if;
  if p_created_via = 'sadran' then
    perform set_config('app.audit_reason', 'create_proposal_supersede_draft', true);
    update public.proposals set status = 'withdrawn'
    where request_id = p_request_id and status = 'draft' and created_via = 'sadran';
    -- (a merge draft was extended above: its legs live on in the new draft, so withdrawing it is bookkeeping)
  end if;

  v_token := public.generate_token();
  perform set_config('app.audit_reason', 'create_proposal', true);

  insert into public.proposals (department_id, week_start, type, status, request_id, ride_id, payload, reason_he,
    previous_status, token_hash, expires_at, created_by, created_via)
  values (v_req.department_id, v_req.week_start, p_type, 'draft', p_request_id, p_ride_id, p_payload, p_reason_he,
    v_req.status, encode(digest(v_token, 'sha256'), 'hex'), null, (select auth.uid()), p_created_via)
  returning id into v_proposal_id;

  v_token := public.generate_token();
  insert into public.proposal_parties (proposal_id, profile_id, request_id, token_hash)
  values (v_proposal_id, v_req.requester_id, p_request_id, encode(digest(v_token, 'sha256'), 'hex'));

  foreach v_party in array coalesce(p_party_profile_ids, '{}') loop
    if v_party <> v_req.requester_id then
      v_token := public.generate_token();
      insert into public.proposal_parties (proposal_id, profile_id, token_hash)
      values (v_proposal_id, v_party, encode(digest(v_token, 'sha256'), 'hex'))
      on conflict (proposal_id, profile_id) do nothing;
    end if;
  end loop;

  return v_proposal_id;
end;
$$;

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
  -- PF1 B3: a Sadran's send waits for other board writes of the week (an ask-to-join is sent from inside the member's
  -- own submit, which already holds row locks — it must not wait here).
  perform public._board_week_lock(p.department_id, p.week_start) from public.proposals p
  where p.id = p_proposal_id and p.created_via = 'sadran';
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
  -- REQ §13.175 (a): a Sadran merge that accepted a long detour is re-checked "as allowed".
  perform public._long_detour_mode(v_prop.created_via='sadran' and coalesce((v_prop.payload->>'allow_long_detour')::boolean,false));
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

CREATE OR REPLACE FUNCTION "public"."agree_proposal_offline"("p_proposal_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_p public.proposals%rowtype;
  v_req public.requests%rowtype;
  v_prev_supp text := coalesce(current_setting('app.suppress_notifications', true), '');
  v_prev_reason text := coalesce(current_setting('app.suppressed_reason', true), '');
  v_prev_defer text := coalesce(current_setting('app.defer_proposal_apply', true), '');
  v_day date; v_public boolean := false; v_party record; v_status public.proposal_status; v_reason text;
  v_result jsonb;
begin
  select * into v_p from public.proposals where id = p_proposal_id;
  if not found then raise exception 'proposal_not_found' using errcode = 'P0001'; end if;
  -- PF1 B3: one board write per department week at a time; the proposal is read again under the lock.
  perform public._board_week_lock(v_p.department_id, v_p.week_start);
  select * into v_p from public.proposals where id = p_proposal_id;
  if not public.can_manage_week(v_p.department_id, v_p.week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  if v_p.status not in ('draft', 'sent') then raise exception 'proposal_not_answerable' using errcode = 'P0001'; end if;
  select * into v_req from public.requests where id = v_p.request_id;
  -- The request's own legs and any shifted times: is any of those days already public?
  for v_day in
    select distinct (t at time zone 'Asia/Jerusalem')::date from unnest(array[
      v_req.depart_at, v_req.return_at,
      nullif(v_p.payload ->> 'depart_at', '')::timestamptz, nullif(v_p.payload ->> 'return_at', '')::timestamptz]) t
    where t is not null
  loop
    if public.is_day_public(v_p.department_id, v_p.week_start, v_day) then v_public := true; end if;
  end loop;

  perform set_config('app.suppress_notifications', 'on', true);
  perform set_config('app.suppressed_reason', '', true);
  perform set_config('app.defer_proposal_apply', 'on', true);
  if v_p.status = 'draft' then
    perform public.send_proposal(p_proposal_id);
  end if;
  for v_party in select profile_id from public.proposal_parties
                 where proposal_id = p_proposal_id and response = 'pending' order by id loop
    perform public.record_answer_on_behalf(p_proposal_id, v_party.profile_id, true, null);
  end loop;
  perform set_config('app.defer_proposal_apply', v_prev_defer, true);

  select status into v_status from public.proposals where id = p_proposal_id;
  if v_status = 'accepted' then
    -- Not public yet: the apply stays silent (members learn it at publish); public: its ordinary notices go out.
    if v_public then perform set_config('app.suppress_notifications', v_prev_supp, true); end if;
    v_result := public._apply_or_wait(p_proposal_id, true);
    v_reason := v_result ->> 'reason';
  end if;
  v_reason := coalesce(v_reason, nullif(current_setting('app.suppressed_reason', true), ''));
  perform set_config('app.suppress_notifications', v_prev_supp, true);
  perform set_config('app.suppressed_reason', v_prev_reason, true);

  if v_result ->> 'status' = 'waiting' then
    return jsonb_build_object('status', 'waiting', 'waiting_for', v_result -> 'waiting_for');
  end if;
  select status into v_status from public.proposals where id = p_proposal_id;
  if v_status = 'withdrawn' then
    return jsonb_build_object('status', 'withdrawn_stale', 'reason', v_reason);
  end if;
  return jsonb_build_object('status', 'applied', 'proposal_status', v_status);
end $$;

CREATE OR REPLACE FUNCTION "public"."_send_draft_proposals"("p_department_id" "uuid", "p_week_start" "date", "p_days" "date"[], "p_skip" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_p record;
  v_prev public.proposals%rowtype;
  v_res jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  -- PF1 B3: the whole batch under the week's board lock, so a second "send all" finds what the first left.
  perform public._board_week_lock(p_department_id, p_week_start);
  for v_p in
    select p.id, p.request_id, (coalesce(q.depart_at, q.return_at) at time zone 'Asia/Jerusalem')::date as day
    from public.proposals p
    join public.requests q on q.id = p.request_id
    where p.department_id = p_department_id and p.week_start = p_week_start
      and p.status = 'draft' and p.created_via = 'sadran'
    order by p.created_at, p.id
  loop
    continue when p_days is not null and not (v_p.day = any(p_days));
    continue when v_p.id = any(coalesce(p_skip, '{}'));
    select * into v_prev from public.proposals where request_id = v_p.request_id and status = 'sent' and id <> v_p.id;
    begin
      v_res := public.send_proposal(v_p.id, '{}'::public.notification_channel[], v_prev.id, v_prev.version);
      v_out := v_out || jsonb_build_array(jsonb_build_object('proposal_id', v_p.id, 'day', v_p.day, 'ok', true,
        'party_tokens', coalesce(v_res -> 'party_tokens', '{}'::jsonb), 'car_conflicts', coalesce(v_res -> 'car_conflicts', '[]'::jsonb)));
    exception when others then
      v_out := v_out || jsonb_build_array(jsonb_build_object('proposal_id', v_p.id, 'day', v_p.day, 'ok', false, 'error', sqlerrm));
    end;
  end loop;
  return v_out;
end $$;
