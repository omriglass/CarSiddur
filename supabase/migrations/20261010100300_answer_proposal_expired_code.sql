-- REQ §13.104 (QA run 4 R4B10): answering a proposal that expired (e.g. a deny/external one expired at publish)
-- raises `proposal_expired` (the UI explains it; an offer replaced by a later one stays not answerable), never the generic `proposal_not_answerable`.
create or replace function public.answer_proposal(p_token text, p_accept boolean, p_note text default null,
  p_via public.answer_channel default 'token')
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_hash text := encode(digest(p_token, 'sha256'), 'hex');
  v_proposal record;
  v_party record;
  v_requester_id uuid;
begin
  perform 1 from public.requests q where q.id in (
    select p.request_id from public.proposals p where p.token_hash=v_hash
    union select p.request_id from public.proposal_parties pp join public.proposals p on p.id=pp.proposal_id where pp.token_hash=v_hash
  ) order by q.id for update;
  select * into v_proposal from public.proposals where token_hash = v_hash;
  if v_proposal.id is not null then
    if v_proposal.status = 'expired' and not exists(select 1 from public.proposals o where o.request_id = v_proposal.request_id and o.id <> v_proposal.id and o.sent_at >= v_proposal.sent_at) then raise exception 'proposal_expired' using errcode = 'P0001'; end if;
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
  if v_party.proposal_status = 'expired' and not exists(select 1 from public.proposals o, public.proposals me where me.id = v_party.proposal_id and o.request_id = me.request_id and o.id <> me.id and o.sent_at >= me.sent_at) then raise exception 'proposal_expired' using errcode = 'P0001'; end if;
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
