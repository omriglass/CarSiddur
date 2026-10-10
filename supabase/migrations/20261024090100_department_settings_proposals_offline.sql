-- REQ §13.123: per-department "proposals handled offline" setting. When on, the Sadran agrees with members on
-- WhatsApp and marks a draft proposal for a not-yet-published day "agreed" (agree_proposal_offline, next migration)
-- instead of sending it from the app. Editable like every other department setting: the existing
-- department_settings_update policy (can_manage_operations) already covers any column.
alter table public.department_settings
  add column proposals_offline boolean not null default false;
comment on column public.department_settings.proposals_offline is
  'REQ §13.123: proposals for unpublished days are agreed offline (WhatsApp) and applied silently via agree_proposal_offline().';
