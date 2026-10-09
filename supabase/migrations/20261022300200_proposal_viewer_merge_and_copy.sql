-- REQ §13.116 (R8B8, R8B10, R7U3): what the /p page shows each reader of a merge, and clearer copy.
-- (1) proposal_viewer_merge: the page used to show the GUEST's request as "your request" to everyone. It now gets, per
--     reader, the role (guest / host / other), the guest's name, the legs actually joined and their times, and the ride's
--     window before/after - computed with the same helpers as proposal_reader_vars (_joiner_times, _merge_check).
-- (2) copy: a passenger who is not the driver is never told "your ride"; external proposals ask the question first, say
--     what accept/decline mean and put the link last.

create or replace function public.proposal_viewer_merge(p_proposal_id uuid, p_profile_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  pr public.proposals%rowtype; q public.requests%rowtype; r public.rides%rowtype;
  v_rides uuid[]; v_role text; v_leg text; v_ride_id uuid; v_mc jsonb; v_jd timestamptz; v_jr timestamptz;
  v_guest text; v_driver text;
begin
  select * into pr from public.proposals where id = p_proposal_id;
  if pr.id is null or pr.type <> 'merge' then return null; end if;
  select * into q from public.requests where id = pr.request_id;
  select full_name into v_guest from public.profiles where id = q.requester_id;
  select array_agg(x.rid order by x.ord) into v_rides
  from (select (l ->> 'ride_id')::uuid as rid, min(ord) as ord
        from jsonb_array_elements(coalesce(pr.payload -> 'legs', '[]')) with ordinality as t(l, ord)
        where coalesce(l ->> 'role', 'passenger') <> 'driver' group by (l ->> 'ride_id')::uuid) x;
  if p_profile_id = q.requester_id then
    v_role := 'guest';
    v_ride_id := v_rides[1];
    select case when count(distinct coalesce(l ->> 'leg', 'both')) > 1 or bool_or(coalesce(l ->> 'leg', 'both') = 'both') then 'both'
                else max(coalesce(l ->> 'leg', 'both')) end into v_leg
    from jsonb_array_elements(coalesce(pr.payload -> 'legs', '[]')) l where coalesce(l ->> 'role', 'passenger') <> 'driver';
  else
    select x.rid into v_ride_id
    from unnest(v_rides) with ordinality as x(rid, ord) join public.rides rd on rd.id = x.rid
    where rd.driver_id = p_profile_id
       or exists (select 1 from public.ride_requests rr join public.requests rq on rq.id = rr.request_id
                  where rr.ride_id = rd.id and rq.requester_id = p_profile_id)
    order by (rd.driver_id = p_profile_id) desc, x.ord limit 1;
    v_ride_id := coalesce(v_ride_id, v_rides[1]);
    select case when count(distinct coalesce(l ->> 'leg', 'both')) > 1 or bool_or(coalesce(l ->> 'leg', 'both') = 'both') then 'both'
                else max(coalesce(l ->> 'leg', 'both')) end into v_leg
    from jsonb_array_elements(coalesce(pr.payload -> 'legs', '[]')) l
    where (l ->> 'ride_id')::uuid = v_ride_id and coalesce(l ->> 'role', 'passenger') <> 'driver';
    v_role := case when exists (select 1 from public.rides rd where rd.id = v_ride_id and rd.driver_id = p_profile_id) then 'host' else 'other' end;
  end if;
  if v_ride_id is null or v_leg is null then return null; end if;
  select * into r from public.rides where id = v_ride_id;
  select full_name into v_driver from public.profiles where id = r.driver_id;
  select jt.dep, jt.ret into v_jd, v_jr from public._joiner_times(r.id, q.id, v_leg::public.ride_leg) jt;
  v_mc := public._merge_check(r.id, q.id, v_leg::public.ride_leg);
  return jsonb_build_object('role', v_role, 'guestName', coalesce(v_guest, ''), 'driverName', coalesce(v_driver, ''), 'leg', v_leg,
    'rideStartsAt', r.starts_at, 'rideEndsAt', r.ends_at,
    'newStartsAt', v_mc ->> 'new_starts_at', 'newEndsAt', v_mc ->> 'new_ends_at',
    'guestDepartAt', case when v_leg in ('out', 'both') then v_jd end,
    'guestReturnAt', case when v_leg in ('return', 'both') then v_jr end,
    'ownDepartAt', case when v_leg in ('out', 'both') then q.depart_at end,
    'ownReturnAt', case when v_leg in ('return', 'both') then q.return_at end);
end $$;

revoke all on function public.proposal_viewer_merge(uuid, uuid) from public;
grant execute on function public.proposal_viewer_merge(uuid, uuid) to service_role;

-- Copy. Rows still equal to their default are replaced; an admin-edited row keeps its text and only its default moves.
create temp table _p3_copy (event public.notification_event, channel public.notification_channel, variant text, title text, body text) on commit drop;
insert into _p3_copy values
 ('proposal_received','inbox','merge_other','הצעה: {{joinerName}} מצטרף/ת לנסיעה שאת/ה נוסע/ת בה{{titleChange}}','{{route}} · {{day}} · {{legWord}} · {{timeChange}}'),
 ('proposal_received','push','merge_other','הצעה: {{joinerName}} מצטרף/ת לנסיעה שאת/ה נוסע/ת בה{{titleChange}}','{{route}} · {{day}} · {{legWord}} · {{timeChange}}'),
 ('proposal_received','whatsapp','merge_other',null,E'היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗\nאני מציע/ה ש{{joinerName}} יצטרף/תצטרף ({{legWord}}) לנסיעה {{route}} ביום {{day}}, שאת/ה נוסע/ת בה.\n{{timeChange}}.\nמתאים/ה? תשובה כאן:\n{{link}}'),
 ('proposal_received','inbox','merge_other_ask','{{joinerName}} מבקש/ת להצטרף לנסיעה שאת/ה נוסע/ת בה{{titleChange}}','{{route}} · {{day}} · {{legWord}} · {{timeChange}}'),
 ('proposal_received','push','merge_other_ask','{{joinerName}} מבקש/ת להצטרף לנסיעה שאת/ה נוסע/ת בה{{titleChange}}','{{route}} · {{day}} · {{legWord}} · {{timeChange}}'),
 ('proposal_received','whatsapp','merge_other_ask',null,E'היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗\n{{joinerName}} מבקש/ת להצטרף ({{legWord}}) לנסיעה {{route}} ביום {{day}}, שאת/ה נוסע/ת בה.\n{{timeChange}}.\nמתאים/ה? תשובה כאן:\n{{link}}'),
 ('proposal_received','whatsapp','external',null,E'היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗\nלצערי כל הרכבים תפוסים {{route}} ביום {{day}} {{depart}}–{{return}}, גם עם הזזה.\n{{reasonNote}}{{externalSuggestion}}\nאם כן — אשר/י כאן והבקשה תיסגר. אם לא — תישאר/י ברשימת ההמתנה ונעדכן אם יתפנה רכב.\n{{link}}'),
 ('proposal_received','whatsapp','external_none',null,E'היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗\nלצערי כל הרכבים תפוסים {{route}} ביום {{day}} {{window}}, גם עם הזזה.\n{{reasonNote}}{{externalSuggestion}}\nאם כן — אשר/י כאן והבקשה תיסגר. אם לא — תישאר/י ברשימת ההמתנה ונעדכן אם יתפנה רכב.\n{{link}}'),
 ('proposal_received','whatsapp','external_city',null,E'היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗\nאין כרגע רכב ב{{city}} {{destinationRoute}} ביום {{day}} {{window}}.\n{{reasonNote}}אפשר להגיע לקיבוץ בעצמך ולצאת משם. אם זה מתאים — אשר/י כאן והבקשה תיסגר. אם לא — תישאר/י ברשימת ההמתנה.\n{{link}}'),
 ('proposal_received','whatsapp','external_city_home',null,E'היי {{firstName}}, אני פונה אליך בכובע של הסידור 🚗\nאין כרגע רכב ב{{city}} {{destinationRoute}} ביום {{day}} {{window}}.\n{{reasonNote}}אפשר להסתדר בעצמך. אם זה מתאים — אשר/י כאן והבקשה תיסגר. אם לא — תישאר/י ברשימת ההמתנה.\n{{link}}');

update public.notification_templates t set
  title = case when t.title is not distinct from t.default_title then c.title else t.title end,
  body = case when t.body is not distinct from t.default_body then c.body else t.body end,
  default_title = c.title, default_body = c.body
from _p3_copy c where t.event = c.event and t.channel = c.channel and t.variant = c.variant;
