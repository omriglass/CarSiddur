-- QA run 10 (REQ §13.112 a, R10U10): the Sadran's `proposal_answered` notice for a plan-B proposal says it was plan B and
-- names the plan: variants `alternative_accepted` / `alternative_declined` (new rows; the vars come from `_alternative_vars`).
-- Full create-or-replace of the trigger function, copied from supabase/schema-current.sql; only the variant and vars are new.
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'proposal_answered', ch.channel::public.notification_channel, t.variant, t.title, t.body, t.title, t.body
from (values
  ('alternative_accepted', '{{firstName}} אישר/ה את תוכנית ב׳', '{{destination}}, יום {{day}} · {{planLine}}'),
  ('alternative_declined', '{{firstName}} דחה/תה את תוכנית ב׳', '{{destination}}, יום {{day}} · {{planLine}}')
) as t(variant, title, body)
cross join (values ('inbox'), ('push')) as ch(channel)
on conflict (event, channel, (coalesce(variant, ''))) do update
  set title = excluded.title, body = excluded.body, default_title = excluded.default_title,
      default_body = excluded.default_body, updated_at = now();

CREATE OR REPLACE FUNCTION "public"."proposal_parties_roll_up"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_total int; v_accepted int; v_declined int; v_status public.proposal_status;
  v_prop record;
  v_new_status public.proposal_status;
  v_who jsonb; v_alt jsonb; v_variant text;
begin
  -- the responder's own offer is handled
  update public.notifications set read_at = now()
  where recipient_id = new.profile_id and event = 'proposal_received' and read_at is null
    and data ->> 'proposal_id' = new.proposal_id::text;
  select status into v_status from public.proposals where id = new.proposal_id;
  -- REQ §13.101 b: the texts name WHO answered (a host or fellow passenger may be the one who declined),
  -- not the request's owner; `firstName` is the variable the answer templates use for that name.
  v_who := jsonb_build_object('firstName', coalesce((select full_name from public.profiles where id = new.profile_id), ''),
                              'byName', coalesce((select full_name from public.profiles where id = new.profile_id), ''));
  if v_status <> 'sent' then
    return new;
  end if;
  select count(*), count(*) filter (where response = 'accepted'), count(*) filter (where response = 'declined')
    into v_total, v_accepted, v_declined
  from public.proposal_parties where proposal_id = new.proposal_id;

  if v_declined > 0 then
    v_new_status := 'declined';
  elsif v_accepted = v_total then
    v_new_status := 'accepted';
  end if;

  if v_new_status is not null then
    update public.proposals set status = v_new_status where id = new.proposal_id
    returning * into v_prop;

    -- R10U10: a plan-B answer says it was plan B and names the plan ("הקפצה ל... עד ...") — variants alternative_accepted / alternative_declined.
    v_variant := case when v_prop.type = 'alternative' and v_new_status in ('accepted', 'declined') then 'alternative_' || v_new_status::text else v_new_status::text end;
    v_alt := case when v_prop.type = 'alternative' then public._alternative_vars(v_prop.payload, v_prop.department_id) else '{}'::jsonb end;
    if v_prop.created_by is not null then
      perform public.enqueue_notification(v_prop.created_by, 'proposal_answered', v_prop.department_id, v_prop.week_start,
        v_who || v_alt, jsonb_build_object('variant', v_variant, 'proposal_id', v_prop.id),
        format('proposal_answered:%s:%s', v_prop.id, v_prop.created_by));
    else
      perform public.enqueue_notification(s.profile_id, 'proposal_answered', v_prop.department_id, v_prop.week_start,
        v_who || v_alt, jsonb_build_object('variant', v_variant, 'proposal_id', v_prop.id),
        format('proposal_answered:%s:%s', v_prop.id, s.profile_id))
      from public.sadranim_of(v_prop.department_id, v_prop.week_start) as s(profile_id);
    end if;

    -- QB15: a decline is news for the other parties too (driver, host, fellow passengers).
    if v_new_status = 'declined' then
      perform public.enqueue_notification(pp.profile_id, 'proposal_answered', v_prop.department_id, v_prop.week_start,
        v_who, jsonb_build_object('variant', 'declined_party', 'proposal_id', v_prop.id, 'request_id', v_prop.request_id),
        format('proposal_answered:%s:%s', v_prop.id, pp.profile_id))
      from public.proposal_parties pp
      where pp.proposal_id = v_prop.id and pp.profile_id <> new.profile_id
        and pp.profile_id is distinct from v_prop.created_by;
    end if;

    if v_new_status = 'accepted' then
      perform public.maybe_apply_accepted_proposal(v_prop.id);
    end if;
  end if;

  return new;
end;
$$;

