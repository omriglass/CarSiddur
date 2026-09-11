// supabase/functions/push-dispatch/index.ts
//
// Drains `push_outbox` rows via Web Push (VAPID). Callers (ARCHITECTURE.md §9,
// §10; DATA_MODEL.md §3.11):
//   1. `push_outbox_notify_dispatch` trigger (AFTER INSERT on push_outbox) —
//      pg_net POSTs `{ outbox_id }` with header `x-cron-secret` immediately.
//   2. `drain_push_outbox()` inside `app.tick()` — same shape, for rows still
//      `pending`/`failed` past their backoff `next_attempt_at`.
//   3. An admin, directly, with `{ notificationIds: string[] }` (Authorization
//      bearer JWT of an `is_admin` profile) for an immediate flush.
//   4. No body / `{}` — pulls every currently-due `pending`/`failed` row
//      itself (bounded batch), for manual/local triage.
//
// `verify_jwt = false` in supabase/config.toml: this function is called by
// pg_net (no JWT) and authenticates the cron path via the shared
// `x-cron-secret` header instead (ARCHITECTURE.md §8); the admin path
// authenticates via a normal user JWT checked here against `profiles.is_admin`.

import { corsHeaders, handleCorsPreflight } from '../_shared/cors.ts';
import { errorResponse, jsonResponse, optionalEnv, requireEnv, timingSafeEqual } from '../_shared/env.ts';
import { bearerToken } from '../_shared/request.ts';
import { getServiceRoleClient, getUserFromJwt } from '../_shared/supabaseAdmin.ts';
// deno-lint-ignore no-explicit-any
import webpush from 'npm:web-push@3';

const BATCH_LIMIT = 200;
const BACKOFF_MINUTES = [1, 5, 15, 60]; // mirrors drain_push_outbox() in 20260907091200_notifications.sql
const DEAD_AFTER_MS = 24 * 60 * 60 * 1000;

interface OutboxRow {
  id: number;
  notification_id: string;
  subscription_id: string;
  payload: { title?: string; body?: string; url?: string; tag?: string };
  status: 'pending' | 'sent' | 'failed' | 'dead';
  attempts: number;
  created_at: string;
  push_subscriptions: { id: string; endpoint: string; p256dh: string; auth: string } | null;
}

function backoffMinutesFor(attempts: number): number {
  return BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)];
}

async function authorize(req: Request): Promise<{ ok: true } | { ok: false; status: number; code: string; message: string }> {
  const cronSecret = optionalEnv('CRON_SECRET');
  const headerSecret = req.headers.get('x-cron-secret') ?? '';
  if (cronSecret && timingSafeEqual(headerSecret, cronSecret)) {
    return { ok: true };
  }

  const jwt = bearerToken(req);
  if (jwt) {
    const user = await getUserFromJwt(jwt);
    if (user) {
      const client = getServiceRoleClient();
      const { data } = await client.from('profiles').select('is_admin').eq('id', user.id).maybeSingle();
      if (data?.is_admin) return { ok: true };
    }
  }

  return { ok: false, status: 401, code: 'not_authorized', message: 'לא מורשה' };
}

async function fetchRows(client: ReturnType<typeof getServiceRoleClient>, filter: (q: ReturnType<typeof client.from>) => unknown) {
  const base = client
    .from('push_outbox')
    .select('id, notification_id, subscription_id, payload, status, attempts, created_at, push_subscriptions(id, endpoint, p256dh, auth)');
  return (await filter(base)) as { data: OutboxRow[] | null; error: { message: string } | null };
}

async function dispatchRow(
  client: ReturnType<typeof getServiceRoleClient>,
  row: OutboxRow,
  now: Date,
): Promise<'sent' | 'failed' | 'dead' | 'skipped'> {
  if (new Date(row.created_at).getTime() <= now.getTime() - DEAD_AFTER_MS) {
    await client.from('push_outbox').update({ status: 'dead' }).eq('id', row.id);
    return 'dead';
  }
  const sub = row.push_subscriptions;
  if (!sub) {
    await client.from('push_outbox').update({ status: 'failed', last_error: 'subscription_missing' }).eq('id', row.id);
    return 'failed';
  }

  const payload = JSON.stringify({
    title: row.payload.title ?? '',
    body: row.payload.body ?? '',
    url: row.payload.url ?? '/',
    tag: row.payload.tag ?? undefined,
  });

  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
    await client.from('push_outbox').update({ status: 'sent', sent_at: now.toISOString() }).eq('id', row.id);
    return 'sent';
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    const message = err instanceof Error ? err.message : String(err);

    if (statusCode === 404 || statusCode === 410) {
      // Dead subscription: delete it (cascades its remaining push_outbox rows,
      // including this one) — ARCHITECTURE.md §9.
      await client.from('push_subscriptions').delete().eq('id', sub.id);
      return 'failed';
    }

    const attempts = row.attempts + 1;
    const nextAttemptAt = new Date(now.getTime() + backoffMinutesFor(attempts) * 60_000);
    await client
      .from('push_outbox')
      .update({ status: 'failed', attempts, last_error: message.slice(0, 500), next_attempt_at: nextAttemptAt.toISOString() })
      .eq('id', row.id);
    return 'failed';
  }
}

Deno.serve(async (req) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return errorResponse(405, 'method_not_allowed', 'שיטה לא נתמכת', corsHeaders);

  const auth = await authorize(req);
  if (!auth.ok) return errorResponse(auth.status, auth.code, auth.message, corsHeaders);

  webpush.setVapidDetails(requireEnv('VAPID_SUBJECT'), requireEnv('VAPID_PUBLIC_KEY'), requireEnv('VAPID_PRIVATE_KEY'));

  let body: { outbox_id?: number; notificationIds?: string[] } = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch {
    return errorResponse(400, 'invalid_body', 'גוף בקשה לא תקין', corsHeaders);
  }

  const client = getServiceRoleClient();
  const now = new Date();
  let rows: OutboxRow[] = [];

  if (typeof body.outbox_id === 'number') {
    const { data, error } = await fetchRows(client, (q) => q.eq('id', body.outbox_id!).limit(1));
    if (error) return errorResponse(500, 'db_error', error.message, corsHeaders);
    rows = data ?? [];
  } else if (Array.isArray(body.notificationIds) && body.notificationIds.length > 0) {
    const { data, error } = await fetchRows(client, (q) =>
      q.in('notification_id', body.notificationIds!).in('status', ['pending', 'failed']).limit(BATCH_LIMIT),
    );
    if (error) return errorResponse(500, 'db_error', error.message, corsHeaders);
    rows = data ?? [];
  } else {
    const { data, error } = await fetchRows(client, (q) =>
      q.in('status', ['pending', 'failed']).lte('next_attempt_at', now.toISOString()).limit(BATCH_LIMIT),
    );
    if (error) return errorResponse(500, 'db_error', error.message, corsHeaders);
    rows = data ?? [];
  }

  const results = { dispatched: rows.length, sent: 0, failed: 0, dead: 0 };
  for (const row of rows) {
    const outcome = await dispatchRow(client, row, now);
    if (outcome === 'sent') results.sent += 1;
    else if (outcome === 'dead') results.dead += 1;
    else if (outcome === 'failed') results.failed += 1;
  }

  return jsonResponse(results, { headers: corsHeaders });
});
