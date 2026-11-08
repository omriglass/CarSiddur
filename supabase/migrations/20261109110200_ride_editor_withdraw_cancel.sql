-- REQ §13.202: an editor may withdraw the owner's request and cancel the owner's ride. withdraw_request / cancel_ride
-- authorize by "is it my request / ride", so these run them as the owner (the caller's identity swapped for the call,
-- restored after), then tell the owner who did it (`ride_edited` variants `editor_withdrew` / `editor_cancelled`).
-- Audit rows of the call itself carry the owner as actor; the notice names the editor.

-- Runs p_sql with auth.uid() = p_owner; always restores the caller.
create or replace function public._run_as_owner(p_owner uuid, p_sql text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_owner, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_owner::text, true);
  begin
    execute p_sql;
  exception when others then
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
    raise;
  end;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
end $$;
revoke all on function public._run_as_owner(uuid, text) from public, anon, authenticated;

create or replace function public.ride_editor_withdraw_request(p_request_id uuid, p_expected_version integer)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare q public.requests%rowtype; v_me uuid := (select auth.uid()); v_name text;
begin
  select * into q from public.requests where id = p_request_id;
  if q.id is null then raise exception 'request_not_found' using errcode = 'P0001'; end if;
  if not public.is_approved() or not public._is_ride_editor(q.department_id, q.requester_id, v_me) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  perform public._run_as_owner(q.requester_id, format('select public.withdraw_request(%L::uuid, %s)', p_request_id, coalesce(p_expected_version::text, 'null')));
  select full_name into v_name from public.profiles where id = v_me;
  perform public.enqueue_notification(q.requester_id, 'ride_edited', q.department_id, q.week_start,
    jsonb_build_object('byName', coalesce(v_name, ''), 'route', coalesce(public.request_route_label(q.id), ''),
      'day', public.day_date_label(coalesce(q.depart_at, q.return_at))),
    jsonb_build_object('variant', 'editor_withdrew', 'request_id', q.id),
    format('editor_withdrew:%s', q.id));
end $$;
revoke all on function public.ride_editor_withdraw_request(uuid, integer) from public, anon;
grant execute on function public.ride_editor_withdraw_request(uuid, integer) to authenticated;

create or replace function public.ride_editor_cancel_ride(p_ride_id uuid, p_reason text, p_expected_version integer default null)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.rides%rowtype; v_me uuid := (select auth.uid()); v_owner uuid; v_request uuid; v_name text;
begin
  select * into r from public.rides where id = p_ride_id;
  if r.id is null or r.status = 'cancelled' then raise exception 'ride_not_found' using errcode = 'P0001'; end if;
  if not public.is_approved() then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  -- whose ride: the driver's, else the first rider (a requester on it) who named the caller
  if public._is_ride_editor(r.department_id, r.driver_id, v_me) then
    v_owner := r.driver_id;
    select rr.request_id into v_request from public.ride_requests rr join public.requests q on q.id = rr.request_id
    where rr.ride_id = r.id and q.requester_id = v_owner order by rr.request_id limit 1;
  else
    select q.requester_id, q.id into v_owner, v_request from public.ride_requests rr join public.requests q on q.id = rr.request_id
    where rr.ride_id = r.id and public._is_ride_editor(r.department_id, q.requester_id, v_me) order by q.id limit 1;
  end if;
  if v_owner is null then raise exception 'not_authorized' using errcode = 'P0001'; end if;
  perform public._run_as_owner(v_owner, format('select public.cancel_ride(%L::uuid, %L, %s)', p_ride_id, p_reason, coalesce(p_expected_version::text, 'null')));
  select full_name into v_name from public.profiles where id = v_me;
  perform public.enqueue_notification(v_owner, 'ride_edited', r.department_id, r.week_start,
    jsonb_build_object('byName', coalesce(v_name, ''), 'route', coalesce(public.request_route_label(v_request), ''),
      'day', public.day_date_label(r.starts_at)),
    jsonb_build_object('variant', 'editor_cancelled', 'ride_id', r.id) || case when v_request is null then '{}'::jsonb else jsonb_build_object('request_id', v_request) end,
    format('editor_cancelled:%s:%s', r.id, v_owner));
end $$;
revoke all on function public.ride_editor_cancel_ride(uuid, text, integer) from public, anon;
grant execute on function public.ride_editor_cancel_ride(uuid, text, integer) to authenticated;
