-- R8B2 (REQ §13.115): publication_readiness() reports unsolvedRequests per day and a day with any is not ready.
create or replace function public.publication_readiness(p_department_id uuid, p_week_start date) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare result jsonb:='[]'; d date; requests_n int; unresolved_n int; incomplete_n int; placed_n int; awaiting_n int; answered_n int; pending_n int; draft_n int; missing_n int; conflicts_n int; alt_n int; unsolved_n int;
begin
  if not public.can_manage_week(p_department_id,p_week_start) then raise exception 'not_authorized';end if;
  if exists(select 1 from public.weeks w where w.department_id=p_department_id and w.week_start=p_week_start and w.phase='upcoming') then raise exception 'week_not_open'; end if;
  for d in select p_week_start+i from generate_series(0,6) i loop
    -- REQ §13.104 (R4B11): "placed" = the request holds a live ride on every leg (driver or not) = the solver's "served".
    -- unresolvedRequests = requests NOT placed (so requestCount - unresolvedRequests = placedRequests = solver served);
    -- incompleteAssignments = assigned/merged requests with a leg no ride covers; awaitingDriverRequests = placed but a leg
    -- only on a ride that still needs a driver (blocks publication through missingDriverRides, not as unresolved).
    select count(*),
      count(*) filter(where not public.request_legs_placed(q.id) and q.status not in ('external','denied')),
      count(*) filter(where q.status in ('assigned','merged') and not public.request_legs_placed(q.id)),
      count(*) filter(where public.request_legs_placed(q.id)),
      count(*) filter(where public.request_legs_placed(q.id) and public.request_awaits_driver(q.id)),
      count(*) filter(where q.status in ('external','denied'))
    into requests_n,unresolved_n,incomplete_n,placed_n,awaiting_n,answered_n from public.requests q where q.department_id=p_department_id and q.week_start=p_week_start
      and q.status not in ('draft','withdrawn','cancelled') and (coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date=d;
    -- 20261011400000 (REQ §13.105 e, R5U3): external/denied requests are answered (not 'unresolved'; counted in answeredRequests)
    -- and an accepted external/deny proposal is no longer 'pending'.
    -- 20261005110300: unsent drafts are counted separately (draftProposals) and no longer in
    -- pendingProposals, so a day with a draft is not blocked twice with two messages.
    select count(*) filter(where p.type<>'alternative' and (p.status='sent' or (p.status='accepted' and p.type not in ('external','deny')))), count(*) filter(where p.status='draft') into pending_n,draft_n
      from public.proposals p join public.requests q on q.id=p.request_id
      where p.department_id=p_department_id and p.week_start=p_week_start and p.status in ('draft','sent','accepted')
        and ((coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date=d
          or exists(select 1 from public.rides r where r.id=p.ride_id and (r.starts_at at time zone 'Asia/Jerusalem')::date=d));
    -- REQ §13.112 (a), R10B3: a SENT plan-B proposal not yet answered/applied blocks the day, counted only here (not in pending); an unsent
    -- plan-B draft is counted once, in draftProposals.
    select count(*) into alt_n from public.proposals p join public.requests q on q.id=p.request_id
      where p.department_id=p_department_id and p.week_start=p_week_start and p.type='alternative' and p.status in ('sent','accepted')
        and (coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date=d;
    pending_n:=pending_n+(select count(*) from public.ride_change_requests c where c.department_id=p_department_id and c.week_start=p_week_start
      and c.status='pending' and (c.starts_at at time zone 'Asia/Jerusalem')::date=d);
    select count(*) into missing_n from public.rides r where r.department_id=p_department_id and r.week_start=p_week_start
      and r.status<>'cancelled' and r.needs_driver and (r.starts_at at time zone 'Asia/Jerusalem')::date=d;
    -- R8B2 (REQ §13.115): a day nobody solved/reviewed is not ready. "Solved" = no request of the day is still 'submitted':
    -- a solver pass moves every request it cannot place to 'waitlisted', a Sadran decision moves it to assigned/merged/
    -- denied/external, so 'submitted' = untouched since filing (or re-opened by a re-solve, or filed after the last solve).
    select count(*) into unsolved_n from public.requests q where q.department_id=p_department_id and q.week_start=p_week_start
      and q.status='submitted' and (coalesce(q.depart_at,q.return_at) at time zone 'Asia/Jerusalem')::date=d;
    select count(distinct id) into conflicts_n from public.publication_conflicting_ride_ids(p_department_id,p_week_start,array[d]) id;
    result:=result||jsonb_build_array(jsonb_build_object('day',d,'published',public.is_day_public(p_department_id,p_week_start,d),
      'requestCount',requests_n,'unresolvedRequests',unresolved_n,'placedRequests',placed_n,'answeredRequests',answered_n,'awaitingDriverRequests',awaiting_n,'incompleteAssignments',incomplete_n,'unsolvedRequests',unsolved_n,
      'pendingProposals',pending_n,'draftProposals',draft_n,'alternativeProposals',alt_n,'missingDriverRides',missing_n,'conflictRides',conflicts_n,
      'ready',unsolved_n=0 and incomplete_n=0 and pending_n=0 and draft_n=0 and alt_n=0 and missing_n=0 and conflicts_n=0));
  end loop;
  return result;
end;
$$;



grant execute on function public.publication_readiness(uuid, date) to authenticated;
