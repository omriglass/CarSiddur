-- REQ §13.99 (QB20 / P1): only a private (temporary) car's owner puts requests on it.
-- Internal guard used by every Sadran/system placement path; ask-to-join to the owner stays allowed
-- (it is a member's own proposal that the owner must accept).

create or replace function public.assert_private_car_owner_only(p_car uuid, p_actor uuid, p_requester uuid) returns void
    language plpgsql stable security definer
    set search_path = public, pg_temp
    as $$
declare v_owner uuid;
begin
  select c.owner_id into v_owner from public.cars c where c.id = p_car and c.type = 'temporary';
  if v_owner is null then return; end if;
  if p_actor is not distinct from v_owner or p_requester is not distinct from v_owner then return; end if;
  raise exception 'private_car_owner_only' using errcode = 'P0001';
end $$;

-- Minutes a chauffeur (drop-off) ride for one leg of a request needs: there and back plus the dwell,
-- on the quarter-hour grid (same formula as place_request_on_car).
create or replace function public.chauffeur_ride_minutes(p_request_id uuid, p_leg public.ride_leg) returns int
    language plpgsql stable security definer
    set search_path = public, pg_temp
    as $$
declare q public.requests%rowtype; v_dwell int; v_travel int;
begin
  select * into q from public.requests where id = p_request_id;
  if q.id is null then return null; end if;
  select coalesce((w.settings_overrides ->> 'chauffeur_dwell_minutes')::int, s.chauffeur_dwell_minutes, 10) into v_dwell
  from public.department_settings s left join public.weeks w on w.department_id = s.department_id and w.week_start = q.week_start
  where s.department_id = q.department_id;
  v_dwell := coalesce(v_dwell, 10);
  v_travel := greatest(coalesce(public.request_leg_route_minutes(q.id, p_leg), 30), 0);
  return greatest(15, ceil((2 * v_travel + greatest(v_dwell, 0)) / 15.0)::int * 15);
end $$;

-- Fingerprint of a host ride for merge proposals: everything except what other passengers joining changes
-- (version, window, turnaround, pin) -- REQ §13.100 QB9.
create or replace function public.ride_merge_fingerprint(p_ride_id uuid) returns text
    language sql stable security definer
    set search_path = public, pg_temp
    as $$
  select md5((to_jsonb(r) - array['version','updated_at','starts_at','ends_at','turnaround_override_minutes','blocked_until','is_pinned','pin_reason'])::text)
  from public.rides r where r.id = p_ride_id;
$$;
