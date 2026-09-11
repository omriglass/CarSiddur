// supabase/functions/_shared/request.ts
//
// Request-parsing helpers that use only web-standard APIs (no `Deno.*`), so
// they can be imported by the pure, Vitest-tested handler modules
// (`destination-route/handler.ts` is compiled by tsconfig.app.json) as well
// as by the Deno entry points. Anything that touches `Deno.env` belongs in
// `env.ts` instead.

/**
 * Extracts the bearer token from an `Authorization` header, if present.
 * Case-insensitive scheme match, trims surrounding whitespace, returns
 * `null` when the header is absent or does not match `Bearer <token>`.
 */
export function bearerToken(req: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
  const token = match?.[1]?.trim();
  return token ? token : null;
}
