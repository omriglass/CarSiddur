-- REQ §13.104 / QA run 5 R5B10: an accepted answer whose proposal is then withdrawn (a failed apply, a later
-- change, the Sadran) put the request back on the waiting list but left its ride `flagged` without a driver
-- with no word about that. At the moment of the withdrawal the requester and the Sadran of the week now get an
-- `outcome_changed` notice (variants `ride_still_needs_driver` / `ride_still_needs_driver_sadran`) when the
-- request sits on a live ride that still needs a driver. A trigger, so every withdrawal path is covered
-- (`withdraw_proposal`, `proposal_system_withdraw`, `answer_proposal`'s stale path) without redefining them.
create or replace function public.proposals_accepted_withdrawn_notice() returns trigger
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
as $$
declare r record; v_to uuid; v_route text; v_day text; v_names text;
begin
  for r in
    select rd.id as ride_id, rd.department_id, rd.week_start, rd.starts_at
    from public.ride_requests rr join public.rides rd on rd.id = rr.ride_id
    where rr.request_id = new.request_id and rd.status <> 'cancelled' and rd.needs_driver
  loop
    v_route := coalesce(public.request_route_label(new.request_id), '');
    v_day := public.day_date_label(r.starts_at);
    select coalesce(p.full_name, '') into v_names from public.requests q join public.profiles p on p.id = q.requester_id where q.id = new.request_id;
    select q.requester_id into v_to from public.requests q where q.id = new.request_id;
    if v_to is not null then
      perform public.enqueue_notification(v_to, 'outcome_changed', r.department_id, r.week_start,
        jsonb_build_object('route', v_route, 'day', v_day),
        jsonb_build_object('variant', 'ride_still_needs_driver', 'ride_id', r.ride_id, 'request_id', new.request_id, 'proposal_id', new.id),
        format('ride_still_needs_driver:%s:%s', new.id, v_to));
    end if;
    perform public.enqueue_notification(s.profile_id, 'outcome_changed', r.department_id, r.week_start,
      jsonb_build_object('route', v_route, 'day', v_day, 'names', coalesce(v_names, '')),
      jsonb_build_object('variant', 'ride_still_needs_driver_sadran', 'ride_id', r.ride_id, 'request_id', new.request_id, 'proposal_id', new.id),
      format('ride_still_needs_driver_sadran:%s:%s', new.id, s.profile_id))
    from public.sadranim_of(r.department_id, r.week_start) as s(profile_id)
    where s.profile_id is distinct from (select auth.uid());
  end loop;
  return new;
end $$;

revoke all on function public.proposals_accepted_withdrawn_notice() from public, anon, authenticated;

drop trigger if exists proposals_accepted_withdrawn_notice on public.proposals;
create trigger proposals_accepted_withdrawn_notice
  after update of status on public.proposals
  for each row when (old.status = 'accepted' and new.status = 'withdrawn')
  execute function public.proposals_accepted_withdrawn_notice();

-- Copy (seeded data; owner to approve wording, docs/COPY_DRAFT_2026-10.md): TODO(copy-approval).
insert into public.notification_templates (event, channel, variant, title, body, default_title, default_body)
select 'outcome_changed', ch, t.variant, t.title, t.body, t.title, t.body
from (values
  ('ride_still_needs_driver', 'ההצעה בוטלה והנסיעה עדיין ללא נהג/ת', '{{route}} · {{day}} — הבקשה חזרה להמתנה, הסדרן/ית יחזרו אליך'),
  ('ride_still_needs_driver_sadran', 'התשובה בוטלה והנסיעה נשארה ללא נהג/ת', '{{names}} · {{route}} · {{day}}')
) as t(variant, title, body)
cross join unnest(array['inbox', 'push']::public.notification_channel[]) as ch
on conflict (event, channel, coalesce(variant, '')) do update
  set title = excluded.title, body = excluded.body, default_title = excluded.default_title, default_body = excluded.default_body;
