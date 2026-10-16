-- scripts/replay/export-week.sql
--
-- Exports one department's week (plus the history the solver reads: fairness
-- lookback, mileage window, car start locations) so `scripts/replay/load-week.mjs`
-- can rebuild it on a disposable local stack and re-run the solver there.
--
-- READ-ONLY BY CONSTRUCTION: one SELECT statement, no function calls with side
-- effects, no DDL/DML. Run it in the Supabase dashboard SQL editor and export the
-- result as JSON or CSV. Personal contact data (email, phone, avatar), invite rows,
-- push subscriptions, notifications, car access codes and proposal tokens are
-- deliberately left out.
--
-- Edit the two values in `params` before running.
--
-- Output: one row per table — (table_name, row_count, rows jsonb).

with params as (
  select
    '998ce266-0d83-4fc7-92dd-62f0384efff3'::uuid as dept,
    date '2026-10-18' as week
),
win as (
  -- 5 weeks back covers fairness (3 weeks) and mileage (4 weeks); 2 ahead covers series legs.
  select dept, week, week - 35 as from_week, week + 14 as to_week from params
),
w_requests as (
  select r.* from public.requests r, win
  where r.department_id = win.dept and r.week_start between win.from_week and win.to_week
),
w_rides as (
  select x.* from public.rides x, win
  where x.department_id = win.dept and x.week_start between win.from_week and win.to_week
),
w_proposals as (
  select p.* from public.proposals p, win
  where p.department_id = win.dept and p.week_start between win.from_week and win.to_week
),
w_children as (
  select c.* from public.children c, win where c.department_id = win.dept
),
w_profile_ids as (
  select dm.profile_id as id from public.department_members dm, win where dm.department_id = win.dept
  union select requester_id from w_requests
  union select filed_by from w_requests where filed_by is not null
  union select driver_id from w_rides where driver_id is not null
  union select rc.profile_id from public.request_companions rc join w_requests r on r.id = rc.request_id
  union select rp.person_id from public.ride_passengers rp join w_rides x on x.id = rp.ride_id where rp.person_id is not null
  union select cg.profile_id from public.child_guardians cg join w_children c on c.id = cg.child_id
  union select sa.profile_id from public.sadran_assignments sa, win where sa.department_id = win.dept
),
w_cars as (
  select c.* from public.cars c, win
  where c.department_id = win.dept
     or c.id in (select car_id from w_rides)
     or c.id in (select preferred_car_id from w_requests where preferred_car_id is not null)
),
w_destination_ids as (
  select d.id from public.destinations d, win where d.department_id = win.dept
  union select home_destination_id from public.departments, win where id = win.dept and home_destination_id is not null
  union select destination_id from w_requests where destination_id is not null
  union select origin_id from w_requests where origin_id is not null
  union select origin_id from w_rides where origin_id is not null
  union select destination_id from w_rides where destination_id is not null
  union select s.place_id from public.request_stops s join w_requests r on r.id = s.request_id where s.place_id is not null
  union select base_location_id from w_cars where base_location_id is not null
  union select default_origin_id from public.department_members, win where department_id = win.dept and default_origin_id is not null
),
w_policies as (
  select p.* from public.policies p, win where p.department_id = win.dept
),
-- Change history of the target week and the week before it (still live while the target is
-- solved: its rides decide where each car starts, and its rides/requests feed fairness and
-- mileage). ride_requests / proposal_parties rows carry no department/week in the audit log,
-- so they are found through their ride / proposal.
w_audit_week as (
  select t.* from public.audit_log t, win
  where t.department_id = win.dept and t.week_start between win.week - 7 and win.week
    and t.table_name in ('requests', 'rides', 'proposals', 'ride_passengers', 'waitlist_groups',
                         'waitlist_group_members', 'weeks')
),
w_audit as (
  select * from w_audit_week
  union all
  select t.* from public.audit_log t
  where t.table_name = 'ride_requests'
    and coalesce(t.after ->> 'ride_id', t.before ->> 'ride_id') in (select row_id from w_audit_week where table_name = 'rides')
  union all
  select t.* from public.audit_log t
  where t.table_name = 'proposal_parties'
    and coalesce(t.after ->> 'proposal_id', t.before ->> 'proposal_id') in (select row_id from w_audit_week where table_name = 'proposals')
)
select 'departments' as table_name, count(*) as row_count, coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) as rows
  from public.departments t, win where t.id = win.dept
union all
select 'department_settings', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]')
  from public.department_settings t, win where t.department_id = win.dept
union all
select 'profiles', count(*), coalesce(jsonb_agg(to_jsonb(t) - 'email' - 'phone' - 'avatar_url'), '[]')
  from public.profiles t where t.id in (select id from w_profile_ids)
union all
select 'department_members', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]')
  from public.department_members t, win where t.department_id = win.dept
union all
select 'sadran_assignments', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]')
  from public.sadran_assignments t, win where t.department_id = win.dept
union all
select 'destinations', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]')
  from public.destinations t where t.id in (select id from w_destination_ids)
union all
select 'place_distances', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]')
  from public.place_distances t, win
  where t.department_id = win.dept
     or (t.from_id in (select id from w_destination_ids) and t.to_id in (select id from w_destination_ids))
union all
select 'ride_types', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]')
  from public.ride_types t, win where t.department_id = win.dept or t.id in (select ride_type_id from w_requests)
union all
select 'cars', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]') from w_cars t
union all
select 'car_seat_configs', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]')
  from public.car_seat_configs t where t.car_id in (select id from w_cars)
union all
select 'car_maintenance_blocks', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]')
  from public.car_maintenance_blocks t where t.car_id in (select id from w_cars)
union all
select 'policies', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]') from w_policies t
union all
select 'policy_versions', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]')
  from public.policy_versions t where t.policy_id in (select id from w_policies)
union all
select 'weeks', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]')
  from public.weeks t, win
  where t.department_id = win.dept and t.week_start between win.from_week and win.to_week
union all
select 'children', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]') from w_children t
union all
select 'child_guardians', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]')
  from public.child_guardians t where t.child_id in (select id from w_children)
union all
select 'requests', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]') from w_requests t
union all
select 'request_stops', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]')
  from public.request_stops t where t.request_id in (select id from w_requests)
union all
select 'request_children', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]')
  from public.request_children t where t.request_id in (select id from w_requests)
union all
select 'request_companions', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]')
  from public.request_companions t where t.request_id in (select id from w_requests)
union all
select 'request_alternatives', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]')
  from public.request_alternatives t where t.request_id in (select id from w_requests)
union all
select 'rides', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]') from w_rides t
union all
select 'ride_requests', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]')
  from public.ride_requests t where t.ride_id in (select id from w_rides)
union all
select 'ride_passengers', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]')
  from public.ride_passengers t where t.ride_id in (select id from w_rides)
union all
select 'proposals', count(*), coalesce(jsonb_agg(to_jsonb(t) - 'token_hash'), '[]') from w_proposals t
union all
select 'proposal_parties', count(*), coalesce(jsonb_agg(to_jsonb(t) - 'token_hash'), '[]')
  from public.proposal_parties t where t.proposal_id in (select id from w_proposals)
union all
select 'waitlist_groups', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]')
  from public.waitlist_groups t, win
  where t.department_id = win.dept and t.week_start between win.from_week and win.to_week
union all
select 'waitlist_group_members', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]')
  from public.waitlist_group_members t, win
  where t.department_id = win.dept and t.week_start between win.from_week and win.to_week
union all
select 'week_stats', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]')
  from public.week_stats t, win
  where t.department_id = win.dept and t.week_start between win.from_week and win.to_week
union all
-- Which solver runs the target week had, and every change since (w_audit) — used to rebuild
-- the week as the solver saw it.
select 'solver_runs', count(*), coalesce(jsonb_agg(to_jsonb(t)), '[]')
  from public.solver_runs t, win where t.department_id = win.dept and t.week_start = win.week
union all
select 'audit_log', count(*), coalesce(jsonb_agg((to_jsonb(t) - 'before' - 'after')
         || jsonb_build_object('before', t.before - 'token_hash', 'after', t.after - 'token_hash') order by t.id), '[]')
  from w_audit t;
