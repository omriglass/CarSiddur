-- DD2 (owner 2026-11-11; production 2026-11-11, Thursday 2026-11-19): drafts stayed open on a cancelled ride —
-- they blocked publishing the day (`publication_drafts`) and kept the request out of solving, although nothing
-- could ever be done with them. A cancelled ride already withdrew the sent/accepted proposals that refer to it;
-- it now also discards the drafts that do (as `discard_proposal` does: status `withdrawn`, nobody is told —
-- a draft was only ever visible to the Sadranim). The proposal being applied right now is skipped, as before.
create or replace function public.rides_withdraw_proposals() returns trigger
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare v_id uuid; v_skip text := coalesce(nullif(current_setting('app.applying_proposal', true), ''), '');
  v_reason text := current_setting('app.audit_reason', true);
begin
  for v_id in
    select p.id from public.proposals p
    where p.status in ('sent','accepted') and p.id::text <> v_skip
      and (p.ride_id = new.id or (p.payload -> 'host_versions') ? new.id::text)
    order by p.id
  loop
    perform public.proposal_system_withdraw(v_id, 'withdrawn_ride');
  end loop;
  if exists (select 1 from public.proposals p
              where p.status = 'draft' and p.id::text <> v_skip
                and (p.ride_id = new.id or (p.payload -> 'host_versions') ? new.id::text)) then
    perform set_config('app.audit_reason', 'draft_ride_cancelled', true);
    update public.proposals p set status = 'withdrawn'
     where p.status = 'draft' and p.id::text <> v_skip
       and (p.ride_id = new.id or (p.payload -> 'host_versions') ? new.id::text);
    perform set_config('app.audit_reason', coalesce(v_reason, ''), true);
  end if;
  return new;
end $$;
