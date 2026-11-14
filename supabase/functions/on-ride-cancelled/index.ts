// supabase/functions/on-ride-cancelled/index.ts
//
// Freed-slot matching (REQUIREMENTS §8; ARCHITECTURE.md §6.3, §11 row
// "on-ride-cancelled"). Invoked by `cancel_ride()` via pg_net
// (`supabase/migrations/20260907091500_rpc.sql`, `on_ride_cancelled_url` app
// setting) with `{ offer_id }` and header `x-cron-secret` — this function
// rejects anything else (`verify_jwt = false` in supabase/config.toml, since
// pg_net sends no user JWT; ARCHITECTURE.md §8).
//
// Pipeline: read the whole ranking input from SQL `freed_slot_rank_input(offer_id)`
// (the offer, the car and its remaining timeline, policy, settings, travel, and
// the candidates `resolve_freed_offer` would keep — DATA_MODEL.md §7.2), rank it
// with the bundled solver's `runFreedSlot()` (SOLVER.md §5.2; the browser runs the
// same pair for its preview line), and hand the ranked list and options to
// `resolve_freed_offer()` — which does the actual writes (0 -> closed; 1 ->
// auto-assign + notify; >1 -> notify all + Sadran contest), per REQUIREMENTS §8.
// `enqueue_notification` is called by that RPC, not by this function.

import { corsHeaders, handleCorsPreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse, optionalEnv, timingSafeEqual } from '../_shared/env.ts';
import { getServiceRoleClient } from '../_shared/supabaseAdmin.ts';
import { runFreedSlot } from '../_shared/solver.js';

// The ranking input comes whole from SQL `freed_slot_rank_input(offer_id)` and is ranked by the bundled solver's
// `runFreedSlot()` (src/solver/freedSlotRun.ts) — the same pair the browser uses for the "what will this change
// cause" line (FC1, REQ item 231), so the two never drift.

/** The few fields of src/solver/freedSlotRun.ts's `FreedSlotRunResult` this function reads (see the NOTE in git history: Deno cannot load the solver's .d.ts tree). */
interface FreedSlotRunResult {
  ranked: { requestId: string; requesterId: string; score: number; reason: string }[];
  options: unknown[];
  outcome: { kind: 'none' | 'held' | 'auto' | 'group' | 'sadran' };
}
interface FreedSlotRawLike {
  offer: { id: string; status: string; groupId: string | null };
  car: unknown;
  policy: unknown;
  candidates: unknown[];
}

async function handle(req: Request, onOffer: (id: string) => void): Promise<Response> {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return errorResponse(405, 'method_not_allowed', corsHeaders);

  const cronSecret = optionalEnv('CRON_SECRET');
  const headerSecret = req.headers.get('x-cron-secret') ?? '';
  if (!cronSecret || !timingSafeEqual(headerSecret, cronSecret)) {
    return errorResponse(401, 'not_authorized', corsHeaders);
  }

  let body: { offer_id?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, 'invalid_body', corsHeaders);
  }
  if (!body.offer_id) return errorResponse(400, 'missing_offer_id', corsHeaders);
  onOffer(body.offer_id);

  const client = getServiceRoleClient();

  const { data: raw, error: rawError } = await client.rpc('freed_slot_rank_input', { p_offer_id: body.offer_id });
  if (rawError) {
    console.error('on-ride-cancelled db_error', rawError.message);
    return errorResponse(500, 'db_error', corsHeaders);
  }
  const input = raw as FreedSlotRawLike | null;
  if (!input) return errorResponse(404, 'offer_not_found', corsHeaders);
  if (input.offer.status !== 'open') {
    // Idempotent: a retried pg_net delivery or a Sadran action may have resolved this already.
    return jsonResponse({ skipped: true, reason: 'offer_not_open', status: input.offer.status }, { headers: corsHeaders });
  }
  if (input.offer.groupId) {
    // REQ §13.101 (i): already held for a contested group; released (group_id cleared) when the group closes.
    return jsonResponse({ skipped: true, reason: 'held_for_group' }, { headers: corsHeaders });
  }

  if (input.candidates.length && !input.car) return errorResponse(500, 'missing_reference_data', corsHeaders);
  if (input.candidates.length && !input.policy) return errorResponse(500, 'no_active_policy', corsHeaders);
  const result = runFreedSlot(input) as FreedSlotRunResult;
  const rankedForRpc = result.ranked.map((c) => ({ request_id: c.requestId, requester_id: c.requesterId }));
  const { error } = await client.rpc('resolve_freed_offer', { p_offer_id: input.offer.id, p_ranked_candidates: rankedForRpc, p_options: result.options });
  if (error) throw new Error(error.message);

  return jsonResponse(
    {
      offerId: input.offer.id,
      outcome: result.outcome.kind === 'none' ? 'closed' : result.outcome.kind === 'auto' ? 'auto_assigned' : 'pending_approval',
      candidates: rankedForRpc.length,
      ranked: result.ranked.map((c) => ({ requestId: c.requestId, score: c.score, reason: c.reason })),
      options: result.options.length,
    },
    { headers: corsHeaders },
  );
}

// R12B3 (REQ §13.119): a failed run is never silent - the offer is closed with the reason and the Sadranim are told
// (`fail_freed_offer`), instead of staying open forever.
async function closeFailed(offerId: string, reason: string): Promise<void> {
  try {
    await getServiceRoleClient().rpc('fail_freed_offer', { p_offer_id: offerId, p_reason: reason });
  } catch (error) {
    console.error('on-ride-cancelled fail_freed_offer', error instanceof Error ? error.message : String(error));
  }
}

Deno.serve(async (req) => {
  let offerId: string | null = null;
  try {
    const response = await handle(req, (id) => {
      offerId = id;
    });
    if (response.status >= 500 && offerId) await closeFailed(offerId, `http_${response.status}`);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('on-ride-cancelled failed', message);
    if (offerId) await closeFailed(offerId, message);
    return errorResponse(500, 'internal_error', corsHeaders);
  }
});
