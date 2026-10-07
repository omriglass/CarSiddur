/**
 * Pure core of browser error reporting (E1, docs/ARCHITECTURE.md §12): URL sanitising, the
 * per-session dedupe/cap gate, the expected-vs-unexpected filter and row building. No Supabase,
 * no React and no globals other than what is passed in, so every rule is unit-testable.
 * `reportClientError.ts` wires it to `api.ts`.
 */

/** Reports allowed per page session; a crash loop must not flood `client_errors`. */
export const REPORT_CAP = 20;
/** The same message is reported at most once per window. */
export const DEDUPE_WINDOW_MS = 60_000;

const MAX_MESSAGE = 1000;
const MAX_STACK = 6000;
const MAX_URL = 500;
const MAX_USER_AGENT = 300;

/** Query parameters that may carry a credential and are therefore never stored. */
const SENSITIVE_PARAM = /token|code|key|secret|auth|jwt|session|password/i;

/**
 * `pathname + search` of the current page, with anything secret removed: `/p/<token>` becomes
 * `/p/…` (ARCHITECTURE.md §8: the token is the credential) and credential-looking query
 * parameters are dropped. The hash fragment is never included (OAuth returns tokens there).
 */
export function sanitizeUrl(pathname: string, search: string): string {
  const path = pathname.replace(/^\/p\/[^/]+/, "/p/…");
  const params = new URLSearchParams(search);
  for (const name of [...params.keys()]) {
    if (SENSITIVE_PARAM.test(name)) params.delete(name);
  }
  const query = params.toString();
  return truncate(query ? `${path}?${query}` : path, MAX_URL);
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * `AppError` codes that are an unexpected failure worth an admin's attention. Every other code
 * is an expected business refusal that already maps to a Hebrew `he.errors.*` message
 * (stale_version, known P0001 identifiers, constraint/duplicate violations, push setup
 * problems on a device) and is not reported.
 */
const UNEXPECTED_CODES: ReadonlySet<string> = new Set(["unknown", "network"]);

export function isUnexpectedErrorCode(code: string): boolean {
  return UNEXPECTED_CODES.has(code);
}

/** Browser noise that is not an application bug. */
const IGNORED_MESSAGES = [/ResizeObserver loop/i, /^Script error\.?$/i];

export function isIgnoredMessage(message: string): boolean {
  return IGNORED_MESSAGES.some((pattern) => pattern.test(message));
}

export interface ReportGate {
  /** True when this message may be sent now (and records it); false when deduped or over the cap. */
  accept(message: string): boolean;
}

export function createReportGate(
  options: { cap?: number; dedupeMs?: number; now?: () => number } = {},
): ReportGate {
  const cap = options.cap ?? REPORT_CAP;
  const dedupeMs = options.dedupeMs ?? DEDUPE_WINDOW_MS;
  const now = options.now ?? (() => Date.now());
  const lastSent = new Map<string, number>();
  let sent = 0;
  return {
    accept(message) {
      if (sent >= cap) return false;
      const at = now();
      const previous = lastSent.get(message);
      if (previous !== undefined && at - previous < dedupeMs) return false;
      lastSent.set(message, at);
      sent += 1;
      return true;
    },
  };
}

export interface ClientErrorInput {
  message: string;
  stack?: string | null;
  /** Where it was caught, e.g. "window.error", "ErrorScreen", "rpc". Stored as the first stack line. */
  context?: string;
}

export interface ClientErrorRow {
  message: string;
  stack: string | null;
  url: string;
  app_version: string;
  user_agent: string;
  profile_id: string;
}

export interface ReportEnvironment {
  pathname: string;
  search: string;
  appVersion: string;
  userAgent: string;
  profileId: string;
}

/** Builds the insert row; message/stack are truncated well inside the DB trigger's own limits. */
export function buildClientErrorRow(input: ClientErrorInput, env: ReportEnvironment): ClientErrorRow {
  const stackParts = [input.context ? `[${input.context}]` : null, input.stack ?? null].filter(
    (part): part is string => !!part,
  );
  return {
    message: truncate(input.message, MAX_MESSAGE),
    stack: stackParts.length > 0 ? truncate(stackParts.join("\n"), MAX_STACK) : null,
    url: sanitizeUrl(env.pathname, env.search),
    app_version: env.appVersion,
    user_agent: truncate(env.userAgent, MAX_USER_AGENT),
    profile_id: env.profileId,
  };
}
