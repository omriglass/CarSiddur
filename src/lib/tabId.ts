/**
 * O28-8 (board speed): one random id per page load, sent as `x-tab-id` on every database API call. The
 * database puts it into the week's change broadcast (`_wcs_flush()`), so a tab can recognise the broadcast
 * of its own change and skip a second reload of data it has just refetched (`features/liveSync/ownChanges.ts`).
 */
export const TAB_ID_HEADER = "x-tab-id";

const TAB_ID: string =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function tabId(): string {
  return TAB_ID;
}

/** Adds the tab id to a PostgREST call (`/rest/v1/`); anything else is untouched. */
export function withTabId(input: RequestInfo | URL, init?: RequestInit): RequestInit | undefined {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("/rest/v1/")) return init;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set(TAB_ID_HEADER, TAB_ID);
  return { ...init, headers };
}
