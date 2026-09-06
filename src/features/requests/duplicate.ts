/**
 * Client-side mirror of the SQL `request_span`/overlap check in
 * `submit_request` (supabase/migrations/20260907091500_rpc.sql: "Duplicate
 * detection (warn, never block, REQ §5.3)"). Used by the request form to
 * show the footer hint ("יש לך כבר בקשה חופפת… — לערוך אותה במקום?") before
 * the member submits — the RPC is still the final arbiter and returns the
 * same `DUPLICATE_OVERLAP` warning independently.
 */
export interface RequestSpan {
  id: string;
  departAt: string | null;
  returnAt: string | null;
}

/** `[start, end]` epoch ms of the inclusive span a request occupies, or `null` for no times at all. */
function spanBounds(span: { departAt: string | null; returnAt: string | null }): [number, number] | null {
  const depart = span.departAt ? new Date(span.departAt).getTime() : null;
  const ret = span.returnAt ? new Date(span.returnAt).getTime() : null;
  if (depart === null && ret === null) return null;
  const start = depart ?? (ret as number);
  const end = ret ?? (depart as number);
  return start <= end ? [start, end] : [end, start];
}

/**
 * The first existing request (other than `excludeId`) whose span overlaps
 * `candidate`'s, or `null`. Mirrors SQL's inclusive `&&` on `tstzrange(…, '[]')`.
 */
export function findOverlappingRequest<T extends RequestSpan>(
  candidate: { departAt: string | null; returnAt: string | null },
  existing: readonly T[],
  excludeId?: string,
): T | null {
  const candidateSpan = spanBounds(candidate);
  if (!candidateSpan) return null;

  for (const request of existing) {
    if (excludeId && request.id === excludeId) continue;
    const span = spanBounds(request);
    if (!span) continue;
    if (candidateSpan[0] <= span[1] && span[0] <= candidateSpan[1]) {
      return request;
    }
  }
  return null;
}
