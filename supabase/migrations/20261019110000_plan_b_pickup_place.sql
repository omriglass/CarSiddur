-- REQ §13.112 (a): the pickup of a plan B may be from a place other than the drop place ("להיות בצומת חריש ב־08:00 ושיאספו
-- אותי מצומת כרכור ב־19:00").
--   * request_alternatives.pickup_place_id / pickup_place_text (both null = pickup from the drop place; only with a pickup).
--   * requests.plan_b_parent_id: when such a plan B is accepted the request becomes the outbound הקפצה and a linked SIBLING request
--     (a הקפצה from the pickup place home, `served_by_alternative`) carries the pickup leg. The pair is one plan-B item: cancelling
--     or withdrawing either request cancels the other (trigger below); `/my` shows one item; fairness counts the pair once.
alter table public.request_alternatives
  add column pickup_place_id uuid,
  add column pickup_place_text text,
  add constraint request_alternatives_pickup_place_ck check (
    (pickup_place_id is null or pickup_place_text is null)
    and (pickup or (pickup_place_id is null and pickup_place_text is null))),
  add constraint request_alternatives_pickup_place_fk foreign key (department_id, pickup_place_id)
    references public.destinations (department_id, id);

alter table public.requests
  add column plan_b_parent_id uuid references public.requests(id) on delete cascade;
create index requests_plan_b_parent_idx on public.requests (plan_b_parent_id) where plan_b_parent_id is not null;

-- Cancelling / withdrawing one request of a plan-B pair ends the other as well (its booking is released first).
create or replace function public._plan_b_pair_cascade() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare s record; v_prev text;
begin
  for s in select id from public.requests
           where status not in ('withdrawn', 'cancelled') and (plan_b_parent_id = new.id or id = new.plan_b_parent_id)
           order by id for update loop
    v_prev := coalesce(current_setting('app.system_status_transition', true), 'off');
    perform public.release_request_booking(s.id);
    perform set_config('app.system_status_transition', 'on', true);
    update public.requests set status = new.status, status_reason = 'PLAN_B_PAIR' where id = s.id;
    perform set_config('app.system_status_transition', v_prev, true);
  end loop;
  return null;
end $$;
revoke all on function public._plan_b_pair_cascade() from public, anon, authenticated;

create trigger requests_plan_b_pair_cascade after update of status on public.requests
  for each row when (new.status in ('withdrawn', 'cancelled') and old.status is distinct from new.status)
  execute function public._plan_b_pair_cascade();

-- The pair counts once in the fairness history: the sibling (pickup leg) weighs 0, the parent keeps `alternativeServedWeight`.
create or replace function public.fairness_stats(p_department_id uuid, p_week_start date, p_lookback_weeks integer)
returns table(profile_id uuid, granted_hours numeric)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_alt numeric;
begin
  if not public.can_manage_week(p_department_id, p_week_start) then
    raise exception 'not_authorized' using errcode='P0001';
  end if;
  v_alt := public.alternative_served_weight(p_department_id);

  return query
    select p.id,
      coalesce(sum(
        coalesce(
          extract(epoch from (q.return_at - q.depart_at)) / 3600.0,
          (select sum(extract(epoch from (r.ends_at-r.starts_at)) / 3600.0)
           from public.ride_requests rr join public.rides r on r.id=rr.ride_id
           where rr.request_id=q.id and r.status<>'cancelled')
        ) * case when q.plan_b_parent_id is not null then 0 when q.served_by_alternative then v_alt else 1 end
      ) filter (where q.status in ('assigned','merged')), 0)::numeric as granted_hours
    from public.department_members dm
    join public.profiles p on p.id=dm.profile_id
    left join public.requests q on q.requester_id=p.id and q.department_id=p_department_id
      and q.week_start >= p_week_start-(p_lookback_weeks*7) and q.week_start<p_week_start
    where dm.department_id=p_department_id and dm.removed_at is null
    group by p.id;
end;
$$;
