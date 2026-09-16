-- Owner notes 2026-09-16 (docs/TODO.md N1, N3):
--
-- N1 — a notification's `{{day}}` var renders "ה׳ 16.9" (20260915100000); in running text
--      it needs the word for "day" in front ("ביום ה׳ 16.9", "יום ה׳ 16.9 08:00–12:00").
--      That word is copy, so it lives in the templates (hard rule 3: seeded data), not in
--      SQL logic: supabase/seed.sql now carries the prefixed bodies/titles, and the UPDATE
--      below applies the same rewrite to production rows the admin never edited
--      (`body = default_body`, `title = default_title`), then refreshes the defaults.
--      Rewrite: `ב{{day}}` → `ביום {{day}}`; a bare `{{day}}` → `יום {{day}}`; an existing
--      `ביום {{day}}` / `ליום {{day}}` is left alone (the `{{DAYOK}}` placeholder protects
--      it through the chained replaces).
--
-- N3 — the inbox/push `proposal_received` body prints `{{proposalShort}}` =
--      `proposals.reason_he`, which the Sadran's composer stores as the *whole* WhatsApp text
--      including the `{{link}}` token it deliberately leaves for send time — so members saw
--      a literal "{{link}}" in the notification. notification_context() now renders that
--      text with `link` = '' (the notification row/push itself already deep-links via
--      `_data.url`, computed by notification_default_url() before the context is built), so
--      no raw token ever reaches a member.

-- ---------------------------------------------------------------------------
-- N1: templates. Applied to `body`/`title` AND `default_body`/`default_title` of every row,
-- edited or not: the `{{day}}` var changed meaning with 20260915100000 (it now carries the
-- date too), so "ב{{day}}" reads wrong in any copy, admin-edited included. Idempotent: an
-- existing "יום {{day}}" (also inside "ביום"/"ליום") is protected through the chain by the
-- `{{DAYOK}}` placeholder, so re-running never yields "יום יום".
-- ---------------------------------------------------------------------------
create or replace function pg_temp.day_prefix(t text) returns text language sql immutable as $$
  select replace(replace(replace(replace(t,
           'יום {{day}}', 'יום {{DAYOK}}'),
           'ב{{day}}', 'ביום {{DAYOK}}'),
           '{{day}}', 'יום {{day}}'),
           '{{DAYOK}}', '{{day}}');
$$;

update public.notification_templates
set body = pg_temp.day_prefix(body),
    title = pg_temp.day_prefix(title),
    default_body = pg_temp.day_prefix(default_body),
    default_title = pg_temp.day_prefix(default_title)
where body like '%{{day}}%' or title like '%{{day}}%' or default_body like '%{{day}}%' or default_title like '%{{day}}%';

drop function pg_temp.day_prefix(text);

-- ---------------------------------------------------------------------------
-- N3: notification_context() — copied whole from 20260915100000_day_date_label.sql; the only
-- change is `proposalShort`.
-- ---------------------------------------------------------------------------
create or replace function public.notification_context(_recipient uuid,_department_id uuid,_week_start date,_data jsonb) returns jsonb
security definer stable set search_path = public, pg_temp language plpgsql as $$
declare q public.requests%rowtype; r public.rides%rowtype; pr public.proposals%rowtype; w public.weeks%rowtype;
  v jsonb; dt timestamptz; dest text; fullname text; carname text;
begin
  select * into w from public.weeks where department_id=_department_id and week_start=_week_start;
  select * into pr from public.proposals where id=nullif(_data->>'proposal_id','')::uuid;
  select * into q from public.requests where id=coalesce(nullif(_data->>'request_id','')::uuid,pr.request_id);
  select rd.* into r from public.rides rd where rd.id=coalesce(nullif(_data->>'ride_id','')::uuid,pr.ride_id,
    (select rr.ride_id from public.ride_requests rr join public.rides x on x.id=rr.ride_id where rr.request_id=q.id and x.status<>'cancelled' limit 1));
  select name into dest from public.destinations where id=q.destination_id;
  select full_name into fullname from public.profiles where id=coalesce(q.requester_id,_recipient);
  select name into carname from public.cars where id=r.car_id;
  dt:=coalesce(q.depart_at,q.return_at,r.starts_at);
  v:=jsonb_build_object('weekLabel',to_char(_week_start,'DD/MM/YY'),
    'closeTime',to_char(w.close_at at time zone 'Asia/Jerusalem','DD/MM HH24:MI'),
    'firstName',coalesce(fullname,''),'destination',coalesce(dest,q.destination_text,''),
    'date',to_char(dt at time zone 'Asia/Jerusalem','DD/MM/YY'),'day',public.day_date_label(dt),
    'depart',to_char(coalesce(r.starts_at,q.depart_at) at time zone 'Asia/Jerusalem','HH24:MI'),
    'return',to_char(coalesce(r.ends_at,q.return_at) at time zone 'Asia/Jerusalem','HH24:MI'),
    'car',coalesce(carname,''),'outcomeLine',coalesce(carname,dest,q.destination_text,''),
    'diffLine',concat_ws(' · ',carname,to_char(coalesce(r.starts_at,dt) at time zone 'Asia/Jerusalem','DD/MM HH24:MI')),
    'sadranName',(select full_name from public.profiles where id=pr.created_by),
    -- N3: the composer's stored WhatsApp text keeps `{{link}}` for send time; a member's
    -- inbox/push must never show the raw token (the row itself deep-links via _data.url).
    'proposalShort',public.render_notification_text(coalesce(pr.reason_he,''),jsonb_build_object('link','')),
    'expiresAt',to_char(pr.expires_at at time zone 'Asia/Jerusalem','DD/MM HH24:MI'),
    'count',coalesce(_data->>'count',''),'email',(select email from public.profiles where id=_recipient));
  return v;
end $$;
revoke execute on function public.notification_context(uuid,uuid,date,jsonb) from public,anon,authenticated;

-- Already-persisted inbox rows: re-render the ones that still carry a raw token.
alter table public.notifications disable trigger notifications_protect_fields;
update public.notifications n set
  title_he=public.render_notification_text(n.title_he,public.notification_context(n.recipient_id,n.department_id,n.week_start,n.data)),
  body_he=public.render_notification_text(n.body_he,public.notification_context(n.recipient_id,n.department_id,n.week_start,n.data))
where title_he like '%{{%' or body_he like '%{{%';
update public.notifications set body_he = replace(body_he, '{{link}}', '') where body_he like '%{{link}}%';
alter table public.notifications enable trigger notifications_protect_fields;
