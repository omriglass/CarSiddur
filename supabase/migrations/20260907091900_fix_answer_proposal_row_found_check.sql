-- Fix (found while smoke-testing the answer-proposal Edge Function): SQL's row
-- `IS NULL` / `IS NOT NULL` is not a plain boolean negation for composite/record
-- values — a row is `IS NULL` only when *every* field is null and `IS NOT NULL`
-- only when *every* field is non-null; a row with a mix of null and non-null
-- columns (e.g. a `proposals` row that hasn't been answered/applied yet, so
-- `ride_id`/`answered_by`/`answered_at`/`answered_via`/`answer_note`/`applied_at`/
-- `applied_ride_id` are still null while `id`/`status`/... are not) makes BOTH
-- `IS NULL` and `IS NOT NULL` evaluate false.
--
-- `answer_proposal()` (20260907091500_rpc.sql) used `if v_proposal is not null
-- then` to mean "found by the proposal-level token" after a
-- `select * into v_proposal from proposals where token_hash = v_hash`. For any
-- real `sent` proposal (always a mix of null/non-null columns) this branch is
-- silently skipped, falling through to the proposal_parties lookup and raising
-- `invalid_token` even for a perfectly valid, unexpired token — reproduced
-- against a real create_proposal/send_proposal proposal while testing this
-- stage's answer-proposal Edge Function. The other RPCs in the same file only
-- use the safe negative form (`if v_x is null then raise ... not_found`, which
-- IS reliable: "not found" really does null out every field) or check a
-- genuinely all-NOT-NULL row shape (`publish_siddur`'s `v_prev`, `siddur_versions`
-- has no nullable columns) — `answer_proposal` was the one place with this bug.
--
-- Fix: check `v_proposal.id is not null` instead (the PK is always non-null
-- when a row was found and always null in an all-null "not found" record) —
-- the standard-safe idiom, equivalent to plpgsql's `FOUND` right after the
-- `SELECT INTO`. Everything else in the function is unchanged. Recorded in
-- docs/DATA_MODEL.md §6.1.

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
  update public.proposal_parties set response = case when p_accept then 'accepted' else 'declined' end,
    responded_at = now(), responded_via = p_via, responded_by = v_party.profile_id
  where id = v_party.id;

  update public.proposals set answered_by = v_party.profile_id, answered_at = now(), answered_via = p_via, answer_note = p_note
  where id = v_party.proposal_id and answered_by is null;

  return jsonb_build_object('proposal_id', v_party.proposal_id, 'accepted', p_accept);
end;
$$;

revoke execute on function public.answer_proposal(text, boolean, text, public.answer_channel) from public, anon;
grant execute on function public.answer_proposal(text, boolean, text, public.answer_channel) to authenticated;
