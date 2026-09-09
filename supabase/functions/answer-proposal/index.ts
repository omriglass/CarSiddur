// supabase/functions/answer-proposal/index.ts
//
// Public (no sign-in) deep-link endpoint for `/p/<token>` (ARCHITECTURE.md §8,
// §6.2; DATA_MODEL.md §3.8). `verify_jwt = false` in supabase/config.toml —
// the token *is* the credential, a random 128-bit secret whose sha256 is the
// only thing stored (`proposals.token_hash` / `proposal_parties.token_hash`).
//
//   GET  ?token=<token>   -> proposal summary for the answer screen (what
//                            changes, expiry, parties by name only — never
//                            phones) without requiring the RPC's write path.
//   POST { token, answer: 'accepted'|'declined', note?, optOut? }
//                         -> calls `answer_proposal(token, accept, note, via)`
//                            with the service role; `via` is 'session' when
//                            the request also carries a verified user JWT,
//                            else 'token' (ARCHITECTURE.md §8). When `optOut`
//                            is a boolean (the deny/external variant's freed-slot
//                            checkbox, Stage 3 hardening fix #3), also sets
//                            `requests.freed_slot_opt_out` directly (service
//                            role bypasses RLS) for the request the token
//                            already proved the caller may answer for — a
//                            no-session caller cannot call the owner/Sadran-gated
//                            `set_freed_slot_opt_out` RPC itself.
//
// Rate-limited by IP (in-memory, see _shared/rateLimit.ts) since this is an
// unauthenticated, guessable-URL-shaped endpoint; the token itself is the
// real defence (unguessable, single-purpose, expiring, revocable).

import { corsHeaders, handleCorsPreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse, sha256Hex } from '../_shared/env.ts';
import { checkRateLimit, clientIp } from '../_shared/rateLimit.ts';
import { getServiceRoleClient, getUserFromJwt } from '../_shared/supabaseAdmin.ts';

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

interface PartySummary {
  profileId: string;
  fullName: string;
  response: 'pending' | 'accepted' | 'declined';
  isYou: boolean;
}

interface ProposalSummary {
  proposalId: string;
  type: string;
  status: string;
  reasonHe: string;
  expiresAt: string;
  payload: unknown;
  // The proposal's own week key — lets a signed-in member's token-answer screen resolve the
  // Sadran contact for the WhatsApp button (`useSadranContactQuery`, src/pages/ProposalTokenPage.tsx)
  // instead of always passing `(undefined, undefined)`. Optional: older cached clients / any
  // future non-week-scoped proposal type may omit them.
  departmentId?: string;
  weekStart?: string;
  request: {
    id: string;
    destination: string | null;
    rideType: string | null;
    departAt: string | null;
    returnAt: string | null;
    adults: number;
    childSeats: number;
    boosters: number;
  } | null;
  parties: PartySummary[];
}

async function findByToken(token: string) {
  const hash = await sha256Hex(token);
  const client = getServiceRoleClient();

  const proposalSelect =
    'id, type, status, reason_he, expires_at, payload, request_id, department_id, week_start, ' +
    'requests(id, requester_id, destination_id, destination_text, depart_at, return_at, adults, child_seats, boosters, ride_type_id, ' +
    'destinations(name), ride_types(name_he))';

  const byProposal = await client.from('proposals').select(proposalSelect).eq('token_hash', hash).maybeSingle();
  if (byProposal.data) {
    const proposal = byProposal.data as unknown as { requests?: { requester_id?: string } };
    return { proposal: byProposal.data as unknown as Record<string, unknown>, myProfileId: proposal.requests?.requester_id ?? null };
  }

  const byParty = await client
    .from('proposal_parties')
    .select(`profile_id, proposals(${proposalSelect})`)
    .eq('token_hash', hash)
    .maybeSingle();
  if (byParty.data && byParty.data.proposals) {
    return { proposal: byParty.data.proposals as unknown as Record<string, unknown>, myProfileId: byParty.data.profile_id as string };
  }

  return null;
}

async function buildSummary(proposal: Record<string, unknown>, myProfileId: string | null): Promise<ProposalSummary> {
  const client = getServiceRoleClient();
  const proposalId = proposal.id as string;

  const { data: parties } = await client
    .from('proposal_parties')
    .select('profile_id, response, profiles!proposal_parties_profile_id_fkey(full_name)')
    .eq('proposal_id', proposalId);

  const request = proposal.requests as
    | {
        id: string;
        destination_id: string | null;
        destination_text: string | null;
        depart_at: string | null;
        return_at: string | null;
        adults: number;
        child_seats: number;
        boosters: number;
        destinations: { name: string } | null;
        ride_types: { name_he: string } | null;
      }
    | null;

  return {
    proposalId,
    type: proposal.type as string,
    status: proposal.status as string,
    reasonHe: proposal.reason_he as string,
    expiresAt: proposal.expires_at as string,
    payload: proposal.payload,
    departmentId: proposal.department_id as string | undefined,
    weekStart: proposal.week_start as string | undefined,
    request: request
      ? {
          id: request.id,
          destination: request.destinations?.name ?? request.destination_text,
          rideType: request.ride_types?.name_he ?? null,
          departAt: request.depart_at,
          returnAt: request.return_at,
          adults: request.adults,
          childSeats: request.child_seats,
          boosters: request.boosters,
        }
      : null,
    // Never include phone (ARCHITECTURE.md §10 / hard rule: only phone_of() reads it, and
    // only for members who share a department/ride — this public endpoint reveals neither).
    parties: (parties ?? []).map((p) => ({
      profileId: p.profile_id as string,
      fullName: (p.profiles as { full_name?: string } | null)?.full_name ?? '',
      response: p.response as PartySummary['response'],
      isYou: myProfileId !== null && p.profile_id === myProfileId,
    })),
  };
}

Deno.serve(async (req) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  const ip = clientIp(req);
  if (!checkRateLimit(`answer-proposal:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
    return errorResponse(429, 'rate_limited', 'יותר מדי בקשות, נסו שוב בעוד דקה', corsHeaders);
  }

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const token = url.searchParams.get('token');
    if (!token) return errorResponse(400, 'missing_token', 'חסר טוקן', corsHeaders);

    const found = await findByToken(token);
    if (!found) return errorResponse(404, 'invalid_token', 'הקישור אינו תקין', corsHeaders);

    const summary = await buildSummary(found.proposal, found.myProfileId);
    return jsonResponse(summary, { headers: corsHeaders });
  }

  if (req.method === 'POST') {
    let body: { token?: string; answer?: string; note?: string; optOut?: boolean };
    try {
      body = await req.json();
    } catch {
      return errorResponse(400, 'invalid_body', 'גוף בקשה לא תקין', corsHeaders);
    }

    const { token, answer, note, optOut } = body;
    if (!token || (answer !== 'accepted' && answer !== 'declined')) {
      return errorResponse(400, 'invalid_body', 'חסרים שדות חובה', corsHeaders);
    }

    let via: 'token' | 'session' = 'token';
    const authHeader = req.headers.get('authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const user = await getUserFromJwt(authHeader.slice('Bearer '.length));
      if (user) via = 'session';
    }

    const client = getServiceRoleClient();
    const { data, error } = await client.rpc('answer_proposal', {
      p_token: token,
      p_accept: answer === 'accepted',
      p_note: note ?? null,
      p_via: via,
    });

    if (error) {
      const code = error.message ?? 'unknown_error';
      if (code.includes('invalid_token')) return errorResponse(404, 'invalid_token', 'הקישור אינו תקין', corsHeaders);
      if (code.includes('proposal_expired')) return errorResponse(410, 'proposal_expired', 'ההצעה פגה', corsHeaders);
      if (code.includes('proposal_not_answerable')) {
        return errorResponse(409, 'proposal_not_answerable', 'ההצעה כבר נענתה או אינה זמינה', corsHeaders);
      }
      return errorResponse(500, 'db_error', 'שגיאה בשמירת התשובה', corsHeaders);
    }

    if (typeof optOut === 'boolean') {
      // Best-effort, secondary to the answer itself — the token already proved the
      // caller may act for this request, so a direct service-role update is enough
      // (no owner/Sadran RLS check needed, unlike the authenticated `set_freed_slot_opt_out`
      // RPC a signed-in caller uses instead, see src/pages/ProposalTokenPage.tsx).
      const found = await findByToken(token);
      const requestId = (found?.proposal.requests as { id?: string } | undefined)?.id;
      if (requestId) {
        await client.from('requests').update({ freed_slot_opt_out: optOut }).eq('id', requestId);
      }
    }

    return jsonResponse(data, { headers: corsHeaders });
  }

  return errorResponse(405, 'method_not_allowed', 'שיטה לא נתמכת', corsHeaders);
});
