-- R19B4 (QA run 19, 2026-11-13): a draft made for a request's old trip type is left over once the trip type changes
-- (the Sadran's `set_request_trip_type`, or a member's edit). Such drafts are discarded silently, as
-- `discard_proposal` and a cancelled ride do (DD2, `20261112160000`): status `withdrawn`, nobody is told.
create or replace function public.requests_trip_type_discards_drafts()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := current_setting('app.audit_reason', true);
begin
  if exists (select 1 from public.proposals p where p.request_id = new.id and p.status = 'draft') then
    perform set_config('app.audit_reason', 'draft_trip_type_changed', true);
    update public.proposals p set status = 'withdrawn' where p.request_id = new.id and p.status = 'draft';
    perform set_config('app.audit_reason', coalesce(v_reason, ''), true);
  end if;
  return new;
end $$;

revoke all on function public.requests_trip_type_discards_drafts() from public;

create trigger requests_trip_type_discards_drafts
  after update of trip_type on public.requests
  for each row when (new.trip_type is distinct from old.trip_type)
  execute function public.requests_trip_type_discards_drafts();
