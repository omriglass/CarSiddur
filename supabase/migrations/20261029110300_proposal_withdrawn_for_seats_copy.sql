-- RC1B5 (QA concurrency run 1, owner 2026-10-29): two merges onto one ride, both accepted; the second could not apply
-- for lack of seats and everyone read "אחרי שינויים בסידור ההצעה כבר לא אפשרית" - nothing in the siddur had changed.
-- A stale withdrawal whose reason is seats now uses seat-specific copy (outcome_changed/proposal_withdrawn_seats for
-- the members who accepted, proposal_answered/withdrawn_seats for the Sadranim), and the Sadran who sent the offer
-- (proposals.sent_by, 20261029110200) is told too. Full definition from schema-current.sql plus those changes.

insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select t.event::public.notification_event, ch.channel::public.notification_channel, t.variant, t.title, t.body, t.title, t.body
from (values
  ('outcome_changed',   'proposal_withdrawn_seats', 'ההצעה שאישרת בוטלה', '{{route}} · {{day}} — כבר אין מספיק מקומות ברכב. הסדרן/ית יחזרו אליך'),
  ('proposal_answered', 'withdrawn_seats',          'ההצעה ל{{firstName}} בוטלה', '{{destination}}, יום {{day}} — אין מספיק מקומות ברכב (מישהו אחר כבר הצטרף)')
) as t(event, variant, title, body)
cross join (values ('inbox'), ('push')) as ch(channel)
on conflict (event, channel, (coalesce(variant, ''))) do update
  set title = excluded.title, body = excluded.body, default_title = excluded.default_title,
      default_body = excluded.default_body, updated_at = now();

CREATE OR REPLACE FUNCTION "public"."proposal_system_withdraw"("p_proposal_id" "uuid", "p_variant" "text", "p_reason" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_p public.proposals%rowtype; v_to uuid; v_sadranim uuid[]; v_rv jsonb;
  -- RC1B5: an offer withdrawn for lack of seats says so (members and Sadranim), not "after changes in the siddur".
  v_seats boolean := p_variant = 'withdrawn_stale'
    and coalesce(p_reason, '') in ('seat_config_violation', 'ride_seats_exceeded', 'passenger_names_exceed_seats');
begin
  select * into v_p from public.proposals where id = p_proposal_id for update;
  if not found or v_p.status not in ('sent','accepted') then return; end if;
  perform set_config('app.audit_reason', 'proposal_system_withdraw', true);
  -- R5B3 noise: this function tells the Sadran (and, for these variants, the members who accepted) itself, so the
  -- accepted-withdrawn trigger's "still needs a driver" notices would be a second notice about the same thing.
  perform set_config('app.system_withdraw_notifies', case when p_variant in ('withdrawn_stale', 'withdrawn_ride', 'withdrawn_dependency') then 'all' else 'sadran' end, true);
  -- O28-1: the tokens are kept, so the members' links say "withdrawn" (answering refuses a non-`sent` proposal).
  update public.proposals set status = 'withdrawn' where id = p_proposal_id;
  perform set_config('app.system_withdraw_notifies', '', true);
  select coalesce(array_agg(s.profile_id), '{}') into v_sadranim from public.sadranim_of(v_p.department_id, v_p.week_start) as s(profile_id);
  -- REQ §13.103 R3B1: the members who accepted are told their answer no longer leads anywhere.
  if p_variant in ('withdrawn_stale', 'withdrawn_ride', 'withdrawn_dependency') then
    for v_to in select pp.profile_id from public.proposal_parties pp
                where pp.proposal_id = v_p.id and pp.response = 'accepted'
                  and pp.profile_id is distinct from v_p.created_by and not (pp.profile_id = any(v_sadranim)) loop
      v_rv := public.proposal_reader_vars(v_p.id, v_to);
      perform public.enqueue_notification(v_to, 'outcome_changed', v_p.department_id, v_p.week_start,
        jsonb_build_object('route', coalesce(v_rv->'vars'->>'route', ''), 'day', coalesce(v_rv->'vars'->>'day', '')),
        jsonb_build_object('variant', case when p_variant = 'withdrawn_dependency' then 'proposal_withdrawn_dependency'
          when v_seats then 'proposal_withdrawn_seats' else 'proposal_withdrawn_stale' end, 'proposal_id', v_p.id, 'request_id', v_p.request_id),
        format('proposal_withdrawn_member:%s:%s', v_p.id, v_to));
    end loop;
  end if;
  for v_to in
    select x from (select v_p.created_by as x where v_p.created_by is not null and v_p.created_via = 'sadran'
                   union select v_p.sent_by where v_p.sent_by is not null and v_p.created_via = 'sadran'   -- RC1B5
                   union select unnest(v_sadranim)) y
    where x is not null
  loop
    perform public.enqueue_notification(v_to, 'proposal_answered', v_p.department_id, v_p.week_start,
      '{}'::jsonb, jsonb_build_object('variant', case when v_seats then 'withdrawn_seats' else p_variant end, 'proposal_id', v_p.id, 'request_id', v_p.request_id)
        || case when p_reason is null then '{}'::jsonb else jsonb_build_object('reason', p_reason) end,
      format('proposal_withdrawn:%s:%s', v_p.id, v_to));
  end loop;
end $$;

