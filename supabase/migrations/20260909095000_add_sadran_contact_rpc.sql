-- The `/p/:token` proposal answer page wants a "talk to the Sadran on WhatsApp" button for
-- signed-in members. `phone_of()` (latest in 20260908130000_weekly_sadran_permissions.sql)
-- deliberately does not cover this case — it lets a Sadran read a member's phone, an admin
-- read anyone's, or two people sharing a ride read each other's, but has no rule for "an
-- ordinary member wants their week's Sadran's phone" — so this is a small, purpose-built
-- SECURITY DEFINER RPC instead of widening phone_of()'s conditions. ARCHITECTURE §8's
-- token-only (no session) `/p/:token` response keeps excluding phone entirely: this RPC
-- requires a real session (`is_approved()`) and is never called from the unauthenticated
-- answer-proposal path.
-- REQ §9; DATA_MODEL.md §3.11 (RPC list); ARCHITECTURE.md §8, §10.
create or replace function public.sadran_contact_of(_department_id uuid, _week_start date)
returns table(person_id uuid, full_name text, phone text)
security definer stable set search_path = public, pg_temp
language plpgsql as $$
begin
  if not (public.is_approved() and public.member_of(_department_id)) then
    raise exception 'not_authorized' using errcode = 'P0001';
  end if;
  return query
    select p.id, p.full_name, p.phone
    from public.sadranim_of(_department_id, _week_start) s(profile_id)
    join public.profiles p on p.id = s.profile_id;
end;
$$;

revoke execute on function public.sadran_contact_of(uuid, date) from public, anon;
grant execute on function public.sadran_contact_of(uuid, date) to authenticated;
