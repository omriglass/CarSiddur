-- Keep an approved administrator available to administer the system. This is
-- enforced at the data boundary so direct PostgREST updates cannot bypass the
-- Members UI's disabled self-revoke button.
create or replace function public.profiles_protect_last_admin() returns trigger
language plpgsql as $$
begin
  if old.is_admin and old.approval_status = 'approved'
     and (not new.is_admin or new.approval_status <> 'approved')
     and not exists (
       select 1 from public.profiles p
       where p.is_admin and p.approval_status = 'approved' and p.id <> old.id
     ) then
    raise exception 'last_admin_required' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger profiles_protect_last_admin before update on public.profiles
  for each row execute function public.profiles_protect_last_admin();
