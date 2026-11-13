-- SA3 (owner 2026-11-11/13, REQ item 223): the send-all preview also shows how each proposal reads on WhatsApp, per party
-- (`proposal_party_texts`, the composer's own text; `{{link}}` left for the browser), next to that person's
-- push/inbox notices. Same rolled-back probe, nothing is sent. Rows: event = 'whatsapp', title = '', keys = proposal:<id>.

create or replace function "public"."preview_send_all"("p_department_id" "uuid", "p_week_start" "date", "p_days" "date"[] DEFAULT NULL::"date"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_seen uuid[];
  v_out jsonb := '[]'::jsonb;
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  -- Notices this transaction wrote before the preview are not part of it (a SQL suite runs in one transaction).
  v_seen := array(select id from public.notifications where department_id = p_department_id and week_start = p_week_start
    and created_at = now());
  begin
    perform set_config('app.held_preview', 'on', true);
    perform public._send_draft_proposals(p_department_id, p_week_start, p_days, null);
    perform public._flush_held_notices(p_department_id, p_week_start, p_days, null);
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', n.id, 'recipient_id', n.recipient_id, 'recipient_name', coalesce(pr.full_name, ''), 'event', n.event,
        'title', n.title_he, 'body', n.body_he,
        'keys', case when coalesce(n.data ->> 'held_keys', '') <> '' then to_jsonb(string_to_array(n.data ->> 'held_keys', ','))
                     when n.data ? 'proposal_id' then jsonb_build_array('proposal:' || (n.data ->> 'proposal_id'))
                     else '[]'::jsonb end)
      order by pr.full_name, n.recipient_id, n.title_he, n.id), '[]'::jsonb)
    into v_out
    from public.notifications n
    left join public.profiles pr on pr.id = n.recipient_id
    where n.department_id = p_department_id and n.week_start = p_week_start and n.created_at = now()
      and not (n.id = any(v_seen));
    -- SA3: each proposal the probe sent, as each party will read it on WhatsApp
    select v_out || coalesce(jsonb_agg(jsonb_build_object(
        'id', 'wa:' || x.proposal_id || ':' || x.profile_id, 'recipient_id', x.profile_id, 'recipient_name', coalesce(pr.full_name, ''),
        'event', 'whatsapp', 'title', '', 'body', x.body, 'keys', jsonb_build_array('proposal:' || x.proposal_id))
      order by pr.full_name, x.profile_id, x.proposal_id), '[]'::jsonb)
    into v_out
    from (
      select p.id as proposal_id, t.profile_id, t.body
      from public.proposals p
      cross join lateral public.proposal_party_texts(p.id) t
      where p.department_id = p_department_id and p.week_start = p_week_start and p.status = 'sent'
        and p.created_via = 'sadran' and p.updated_at = now() and coalesce(t.body, '') <> ''
    ) x
    left join public.profiles pr on pr.id = x.profile_id;
    raise exception 'send_all_preview' using errcode = 'PXPV1';
  exception when sqlstate 'PXPV1' then
    null;  -- everything the probe did is undone; v_out survives
  end;
  return v_out;
end $$;
