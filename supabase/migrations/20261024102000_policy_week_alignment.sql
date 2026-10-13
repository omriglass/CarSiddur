-- REQ §13 (owner 2026-10-13): member-facing "הצג מדיניות" page. Aggregate-only answer to "of the
-- pairs of requests that competed for a car in the department's latest scored week, how many were
-- decided the way this policy ranks them?". Returns counts only, never ids/names/per-request data.
create or replace function public.policy_week_alignment(p_policy_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_dept uuid;
  v_week date;
  v_element jsonb;
  v_today date := (now() at time zone 'Asia/Jerusalem')::date;
  v_pairs int; v_followed int; v_reversed int; v_tied int;
begin
  select department_id into v_dept from public.policies where id = p_policy_id;
  if v_dept is null or not (public.is_admin() or public.member_of(v_dept)) then
    raise exception 'not_authorized';
  end if;

  select l.week_start, e.elem into v_week, v_element
  from (
    select distinct on (s.week_start) s.week_start, s.snapshot
    from public.siddur_versions s
    where s.department_id = v_dept and s.week_start <= v_today
    order by s.week_start desc, s.version_no desc
  ) l
  cross join lateral (
    select ps as elem
    from jsonb_array_elements(coalesce(l.snapshot -> 'policy_scores', '[]'::jsonb)) ps
    where ps ->> 'policy_id' = p_policy_id::text
    limit 1
  ) e
  order by l.week_start desc
  limit 1;

  if v_week is null then
    return null;
  end if;

  with items as (
    select (r ->> 'request_id')::uuid as request_id,
           (r ->> 'score')::numeric as score,
           coalesce((r ->> 'served')::boolean, false) as served
    from jsonb_array_elements(coalesce(v_element -> 'profiles', '[]'::jsonb)) p,
         jsonb_array_elements(coalesce(p -> 'requests', '[]'::jsonb)) r
    where r ->> 'score' is not null
  ),
  timed as (
    select i.score, i.served, q.requester_id, q.series_id,
           coalesce(q.depart_at, q.return_at) as s_at,
           coalesce(q.return_at, q.depart_at) as e_at
    from items i
    join public.requests q on q.id = i.request_id and q.department_id = v_dept
    where coalesce(q.depart_at, q.return_at) is not null
  ),
  pairs as (
    select a.score as sa, b.score as sb
    from timed a
    join timed b on a.served and not b.served
      and (a.s_at at time zone 'Asia/Jerusalem')::date = (b.s_at at time zone 'Asia/Jerusalem')::date
      and a.s_at < b.e_at and b.s_at < a.e_at
      and a.requester_id <> b.requester_id
      and (a.series_id is null or b.series_id is null or a.series_id <> b.series_id)
  )
  select count(*),
         count(*) filter (where sa - sb > 1e-9),
         count(*) filter (where sb - sa > 1e-9),
         count(*) filter (where abs(sa - sb) <= 1e-9)
  into v_pairs, v_followed, v_reversed, v_tied
  from pairs;

  return jsonb_build_object('week_start', v_week, 'pairs', v_pairs,
    'followed', v_followed, 'reversed', v_reversed, 'tied', v_tied);
end;
$$;

revoke all on function public.policy_week_alignment(uuid) from public, anon;
grant execute on function public.policy_week_alignment(uuid) to authenticated;
