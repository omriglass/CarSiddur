-- O28-3 (owner 2026-10-28): a proposal that can no longer be answered (withdrawn / expired) leaves the inbox — its
-- `proposal_received` notices are deleted (20261029102300). send_proposal() decides whether a new offer on the same
-- request is quiet (no push) from whether the person opened the earlier offer's notice (owner 2026-10-23, notification
-- noise); once that notice is gone, this column remembers it: true = the person opened it, false = never opened (or
-- only the system cleared it), null = no notice was deleted for this party.

alter table public.proposal_parties add column offer_notice_opened boolean;

comment on column public.proposal_parties.offer_notice_opened is
  'O28-3: set when the proposal ended (withdrawn/expired) and its proposal_received notice for this party was deleted: '
  'whether the party had opened it. Read by send_proposal() for a quiet replacement offer.';
