-- Stage 3 hardening fix (bug found while writing e2e/proposal.spec.ts): `answer_proposal()`
-- has two near-identical branches — one for a token matching `proposals.token_hash` directly
-- (the sole-party convenience token `send_proposal()` also returns as `proposal_token`), one
-- for a token matching `proposal_parties.token_hash` (the *actual* per-party tokens
-- `send_proposal()` returns in `party_tokens`, the ones a real WhatsApp message links to,
-- `waButtonFor()` in `ProposalComposerScreen.tsx`). `20260907091900_fix_answer_proposal_row_
-- found_check.sql` added an explicit `::public.party_response` cast to the *first* branch's
-- `update proposal_parties set response = case when p_accept then 'accepted' else 'declined'
-- end` (Postgres does not always resolve a bare string-literal `CASE` embedded in a query
-- against the target enum column) but missed the second, structurally identical branch —
-- reproduced directly against the local stack via a real create_proposal/send_proposal/
-- answer_proposal round trip using the party token:
--
--   ERROR:  column "response" is of type party_response but expression is of type text
--   CONTEXT:  PL/pgSQL function answer_proposal(text,boolean,text,answer_channel) line 35
--
-- This is the realistic path for every actual proposal answered by a real party (single- or
-- multi-party) via its WhatsApp link, so it was previously broken for every such answer.
-- Fix: the same cast, added to the second branch. Full body reproduced verbatim otherwise.
create or replace function public.answer_proposal(p_token text, p_accept boolean, p_note text default null,
  p_via public.answer_channel default 'token') returns jsonb
security definer set search_path = public, pg_temp
language plpgsql as $$
declare
  v_hash text := encode(digest(p_token, 'sha256'), 'hex');
  v_proposal record;
  v_party record;
  v_requester_id uuid;
begin
  select * into v_proposal from public.proposals where token_hash = v_hash;
  if v_proposal.id is not null then
    if v_proposal.status <> 'sent' then raise exception 'proposal_not_answerable' using errcode = 'P0001'; end if;
    if now() > v_proposal.expires_at then raise exception 'proposal_expired' using errcode = 'P0001'; end if;

    select requester_id into v_requester_id from public.requests where id = v_proposal.request_id;
    perform set_config('app.audit_reason', 'answer_proposal', true);

    update public.proposal_parties set response = (case when p_accept then 'accepted' else 'declined' end)::public.party_response,
      responded_at = now(), responded_via = p_via, responded_by = v_requester_id
    where proposal_id = v_proposal.id and profile_id = v_requester_id;

    update public.proposals set answered_by = v_requester_id, answered_at = now(), answered_via = p_via, answer_note = p_note
    where id = v_proposal.id;

    return jsonb_build_object('proposal_id', v_proposal.id, 'accepted', p_accept);
  end if;

  select pp.*, p.status as proposal_status, p.expires_at as proposal_expires_at, p.id as proposal_id
    into v_party
  from public.proposal_parties pp join public.proposals p on p.id = pp.proposal_id
  where pp.token_hash = v_hash;
  if v_party.proposal_id is null then raise exception 'invalid_token' using errcode = 'P0001'; end if;
  if v_party.proposal_status <> 'sent' then raise exception 'proposal_not_answerable' using errcode = 'P0001'; end if;
  if now() > v_party.proposal_expires_at then raise exception 'proposal_expired' using errcode = 'P0001'; end if;

  perform set_config('app.audit_reason', 'answer_proposal', true);
  update public.proposal_parties set response = (case when p_accept then 'accepted' else 'declined' end)::public.party_response,
    responded_at = now(), responded_via = p_via, responded_by = v_party.profile_id
  where id = v_party.id;

  update public.proposals set answered_by = v_party.profile_id, answered_at = now(), answered_via = p_via, answer_note = p_note
  where id = v_party.proposal_id and answered_by is null;

  return jsonb_build_object('proposal_id', v_party.proposal_id, 'accepted', p_accept);
end;
$$;
