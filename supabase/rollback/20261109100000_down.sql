-- Rollback of 20261109100000_add_needs_tow_hitch.sql: restore the luggage-only waiver rule and trigger.
-- (needs_tow_hitch columns are additive and may stay; a waiver that only stood on towing is cleared first.)
update public.requests set luggage_waived_at = null, luggage_waived_by = null where luggage_waived_at is not null and not has_luggage;
alter table public.requests drop constraint requests_luggage_waiver_ck;
alter table public.requests add constraint requests_luggage_waiver_ck check (luggage_waived_at is null or has_luggage);

create or replace function public.requests_clear_luggage_waiver() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.luggage_waived_at is not null and new.has_luggage is distinct from old.has_luggage then
    new.luggage_waived_at := null;
    new.luggage_waived_by := null;
  end if;
  return new;
end $$;

create or replace trigger requests_clear_luggage_waiver
  before update of has_luggage on public.requests
  for each row execute function public.requests_clear_luggage_waiver();
