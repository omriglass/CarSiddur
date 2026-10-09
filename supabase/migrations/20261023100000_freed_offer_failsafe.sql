-- R12B3 (REQ §13.119): a freed-car offer never stays open after a failed run.
alter table public.freed_slot_offers add column if not exists close_reason text;

-- Probe: would placing this candidate on the freed car succeed right now? (rolled back, no side effects)
CREATE OR REPLACE FUNCTION "public"."freed_candidate_placeable"("p_offer_id" "uuid", "p_request_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  begin
    perform public.place_freed_slot_request(p_offer_id, p_request_id, null, 'FREED_SLOT_PROBE');
    raise exception 'freed_probe_ok' using errcode = 'P0001';
  exception when others then
    return sqlerrm = 'freed_probe_ok';
  end;
end $$;
ALTER FUNCTION "public"."freed_candidate_placeable"("p_offer_id" "uuid", "p_request_id" "uuid") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."freed_candidate_placeable"("p_offer_id" "uuid", "p_request_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."freed_candidate_placeable"("p_offer_id" "uuid", "p_request_id" "uuid") TO "service_role";

-- Close an offer whose resolution failed (edge function error, placement refusal) and tell the Sadranim.
CREATE OR REPLACE FUNCTION "public"."fail_freed_offer"("p_offer_id" "uuid", "p_reason" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_offer public.freed_slot_offers%rowtype; v_car text;
begin
  select * into v_offer from public.freed_slot_offers where id = p_offer_id for update;
  if v_offer.id is null or v_offer.status not in ('open', 'pending_approval') then return; end if;
  update public.freed_slot_offers set status = 'closed', resolved_at = now(), close_reason = left(coalesce(p_reason, 'unknown'), 200)
  where id = p_offer_id;
  select name into v_car from public.cars where id = v_offer.car_id;
  perform public.enqueue_notification(s.profile_id, 'claim_contested', v_offer.department_id, v_offer.week_start,
    jsonb_build_object('car', coalesce(v_car, ''), 'day', public.day_date_label(v_offer.starts_at),
      'timeRange', to_char(v_offer.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI') || '–' || to_char(v_offer.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI')),
    jsonb_build_object('offer_id', p_offer_id, 'variant', 'freed_failed'), format('freed_failed:%s', p_offer_id))
  from public.sadranim_of(v_offer.department_id, v_offer.week_start) as s(profile_id);
end $$;
ALTER FUNCTION "public"."fail_freed_offer"("p_offer_id" "uuid", "p_reason" "text") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."fail_freed_offer"("p_offer_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fail_freed_offer"("p_offer_id" "uuid", "p_reason" "text") TO "service_role";

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body) values
  ('claim_contested', 'inbox', 'freed_failed', 'רכב שהתפנה לא נמסר — דרושה בדיקה',
   '{{car}}, יום {{day}} {{timeRange}}. לא הצלחנו להציע אותו אוטומטית; אפשר לשבץ בקשה ידנית בלוח.',
   'רכב שהתפנה לא נמסר — דרושה בדיקה', '{{car}}, יום {{day}} {{timeRange}}. לא הצלחנו להציע אותו אוטומטית; אפשר לשבץ בקשה ידנית בלוח.'),
  ('claim_contested', 'push', 'freed_failed', 'רכב שהתפנה לא נמסר — דרושה בדיקה',
   '{{car}}, יום {{day}} {{timeRange}}. לא הצלחנו להציע אותו אוטומטית; אפשר לשבץ בקשה ידנית בלוח.',
   'רכב שהתפנה לא נמסר — דרושה בדיקה', '{{car}}, יום {{day}} {{timeRange}}. לא הצלחנו להציע אותו אוטומטית; אפשר לשבץ בקשה ידנית בלוח.')
on conflict (event, channel, (coalesce(variant, ''))) do nothing;

CREATE OR REPLACE FUNCTION "public"."resolve_freed_offer"("p_offer_id" "uuid", "p_ranked_candidates" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_offer record;
  v_count int;
  v_first jsonb;
  v_ride_id uuid;
  v_cand jsonb;
  v_group uuid; v_g record; m record; v_car_name text;
  v_prio uuid[]; v_ok jsonb := '[]'::jsonb;
begin
  select * into v_offer from public.freed_slot_offers where id = p_offer_id;
  if v_offer is null then raise exception 'offer_not_found' using errcode = 'P0001'; end if;
  if v_offer.status <> 'open' then raise exception 'offer_not_open' using errcode = 'P0001'; end if;

  -- R12B3 (REQ §13.119): a candidate the freed car cannot really take (the car is not at the leg's place, a turnaround...)
  -- is dropped here, so the lone-candidate placement below cannot fail with car_not_at_leg_place.
  for v_cand in select * from jsonb_array_elements(coalesce(p_ranked_candidates, '[]')) loop
    if public.freed_candidate_placeable(p_offer_id, (v_cand ->> 'request_id')::uuid) then v_ok := v_ok || jsonb_build_array(v_cand); end if;
  end loop;
  p_ranked_candidates := v_ok;
  v_count := jsonb_array_length(p_ranked_candidates);
  perform set_config('app.audit_reason', 'resolve_freed_offer', true);

  -- REQ §13.101 (i): the open contested group whose time this car frees goes first.
  v_group := public.freed_offer_group(p_offer_id);
  if v_group is not null and v_count > 0 then
    select coalesce(array_agg(wm.request_id), '{}') into v_prio from public.waitlist_group_members wm
    where wm.group_id = v_group and wm.chosen is null
      and wm.request_id in (select (c ->> 'request_id')::uuid from jsonb_array_elements(p_ranked_candidates) c);
    if cardinality(v_prio) > 0 then
      select * into v_g from public.waitlist_groups where id = v_group;
      select name into v_car_name from public.cars where id = v_offer.car_id;
      update public.freed_slot_offers set group_id = v_group where id = p_offer_id;
      for m in select wm.request_id, wm.profile_id from public.waitlist_group_members wm
               where wm.group_id = v_group and wm.chosen is null order by wm.created_at, wm.id loop
        perform public.enqueue_notification(m.profile_id, 'waitlist_contested', v_g.department_id, v_g.week_start,
          jsonb_build_object('car', coalesce(v_car_name, ''), 'day', public.day_date_label(v_g.starts_at),
            'depart', to_char(v_g.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI'),
            'return', to_char(v_g.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI')),
          jsonb_build_object('group_id', v_group, 'request_id', m.request_id, 'day', v_g.day::text, 'variant', 'car_freed'),
          format('waitlist_car_freed:%s:%s:%s', v_group, p_offer_id, m.profile_id));
      end loop;
      perform public.enqueue_notification(s.profile_id, 'waitlist_contested', v_g.department_id, v_g.week_start,
        jsonb_build_object('car', coalesce(v_car_name, ''), 'day', public.day_date_label(v_g.starts_at),
          'depart', to_char(v_g.starts_at at time zone 'Asia/Jerusalem', 'HH24:MI'),
          'return', to_char(v_g.ends_at at time zone 'Asia/Jerusalem', 'HH24:MI')),
        jsonb_build_object('group_id', v_group, 'day', v_g.day::text, 'variant', 'car_freed_sadran'),
        format('waitlist_car_freed:%s:%s:sadran:%s', v_group, p_offer_id, s.profile_id))
      from public.sadranim_of(v_g.department_id, v_g.week_start) as s(profile_id);
      return;
    end if;
  end if;

  if v_count = 0 then
    update public.freed_slot_offers set status = 'closed', resolved_at = now() where id = p_offer_id;
  elsif v_count = 1 then
    v_first := p_ranked_candidates -> 0;
    begin
      v_ride_id := public.place_freed_slot_request(p_offer_id, (v_first ->> 'request_id')::uuid, null, 'FREED_SLOT_AUTO');
    exception when others then
      -- never silently stuck: close the offer with the reason and tell the Sadran
      perform public.fail_freed_offer(p_offer_id, sqlerrm);
      return;
    end;

    update public.freed_slot_offers set status = 'auto_assigned', resolved_at = now(),
      winning_request_id = (v_first ->> 'request_id')::uuid
    where id = p_offer_id;

    perform public.enqueue_notification((v_first ->> 'requester_id')::uuid, 'freed_slot_auto', v_offer.department_id, v_offer.week_start,
      '{}'::jsonb, jsonb_build_object('ride_id', v_ride_id, 'request_id', (v_first ->> 'request_id')::uuid), format('freed_slot_auto:%s', p_offer_id));
  else
    for v_cand in select * from jsonb_array_elements(p_ranked_candidates) loop
      insert into public.freed_slot_claims (offer_id, request_id, profile_id, status, offered_at)
      values (p_offer_id, (v_cand ->> 'request_id')::uuid, (v_cand ->> 'requester_id')::uuid, 'offered', now())
      on conflict (offer_id, request_id) do nothing;
      perform public.enqueue_notification((v_cand ->> 'requester_id')::uuid, 'freed_slot', v_offer.department_id, v_offer.week_start,
        '{}'::jsonb, jsonb_build_object('offer_id', p_offer_id, 'request_id', (v_cand ->> 'request_id')::uuid),
        format('freed_slot:%s:%s', p_offer_id, v_cand ->> 'request_id'));
    end loop;
    update public.freed_slot_offers set status = 'pending_approval' where id = p_offer_id;
    perform public.enqueue_notification(s.profile_id, 'claim_contested', v_offer.department_id, v_offer.week_start,
      jsonb_build_object('count', v_count::text), jsonb_build_object('offer_id', p_offer_id), format('claim_contested:%s', p_offer_id))
    from public.sadranim_of(v_offer.department_id, v_offer.week_start) as s(profile_id);
  end if;
end;
$$;

ALTER FUNCTION "public"."resolve_freed_offer"("p_offer_id" "uuid", "p_ranked_candidates" "jsonb") OWNER TO "postgres";
