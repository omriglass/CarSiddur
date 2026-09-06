// supabase/functions/_shared/env.ts
//
// Small env-var helpers shared by every Edge Function. Secrets are Edge
// Function secrets (`npx supabase secrets set`, or `supabase/functions/.env`
// locally, gitignored) — never in the repo or `VITE_*` (ARCHITECTURE.md §13).

export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`missing required env var: ${name}`);
  }
  return value;
}

export function optionalEnv(name: string, fallback = ''): string {
  return Deno.env.get(name) ?? fallback;
}

/**
 * Constant-time-ish string compare: always walks the longer of the two
 * buffers so the number of XOR steps does not depend on where the first
 * mismatch is, which is the timing signal that matters for a secret
 * compare. Used for the shared cron secret and (defense in depth) for any
 * direct token comparison outside the DB's own indexed hash lookup.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/** sha256(text) as lowercase hex, matching Postgres's `encode(digest(text, 'sha256'), 'hex')`. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function jsonResponse(body: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

export function errorResponse(status: number, code: string, message_he: string, headers: Record<string, string> = {}): Response {
  return jsonResponse({ error: { code, message_he } }, { status, headers });
}
