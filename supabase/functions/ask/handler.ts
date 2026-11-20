/**
 * REQ item 258 (AI1, "Ask in words"): one chat turn. Never changes anything in the siddur — it returns a checked draft
 * the app shows as a card; the member then confirms in the regular form.
 *
 *   POST { department_id, message, conversation_id?, draft? }
 *   → 200 { conversation_id, turn_id, draft, refs, rides, people }
 *        refs: RIDE_n → request id (the draft names rides by ref); rides: the member's rides as the model saw them (for
 *        the "which ride?" chips and the edit card's "before"); people: name → { id, kind } | null (two with the name)
 *   → 4xx/503 { error: { code }, conversation_id? }        codes only, no Hebrew (the app words them)
 *
 *   POST { probe: true } → 200 { available, code? }   (owner 2026-11-20: the app greys "לכתוב במילים" out before the
 *   member types anything) — no key → `ask_not_configured`; otherwise the key and model are checked with Google's
 *   model lookup (no generation quota spent), remembered 10 minutes when fine and 1 minute when not.
 *
 * `draft` lets the app send the draft after a local change (a tapped "which ride?" chip); it is re-checked like any
 * model answer. Every turn — also a failed one — is recorded through the service-role RPCs (ask_begin_turn /
 * ask_record_turn); the context is read as the member (`ask_context`, refused unless the admin opted them in).
 */
import { corsHeaders } from "../_shared/cors.ts";
import { bearerToken } from "../_shared/request.ts";
import { buildAskContext, type AskContextRow } from "../_shared/askContext.ts";
import { buildGenerateRequest, PROMPT_VERSION } from "../_shared/askPrompt.ts";
import { normalizeAnswer, type AskDraft, type AskModelAnswer } from "../_shared/askNormalize.ts";

export interface AskBegin { conversation_id: string; position: number; previous_draft: AskDraft | null; messages: string[] }
export interface AskTurnRecord {
  user_text: string; draft_in: AskDraft | null; raw_answer: unknown; draft: AskDraft | null; flags: string[];
  error: string | null; prompt_version: string; model: string; latency_ms: number;
}
/** A dependency failure carrying one of the machine codes below (the RPCs raise them as their message). */
export class AskError extends Error {}

export interface AskDependencies {
  authenticate: (jwt: string) => Promise<string | null>;
  loadContext: (jwt: string, departmentId: string) => Promise<AskContextRow>;
  beginTurn: (profileId: string, departmentId: string, conversationId: string | null) => Promise<AskBegin>;
  recordTurn: (conversationId: string, position: number, turn: AskTurnRecord) => Promise<string>;
  apiKey: string;
  model: string;
  fetch: typeof fetch;
  now?: () => Date;
}

const GEMINI = "https://generativelanguage.googleapis.com/v1beta/models";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS: Record<string, number> = {
  not_authorized: 403, not_found: 409, conversation_ended: 409, daily_limit: 429, conversation_too_long: 429,
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function failure(code: string, status: number, extra: Record<string, unknown> = {}) {
  return response({ error: { code }, ...extra }, status);
}
const codeOf = (e: unknown) => (e instanceof AskError ? e.message : null);

const probeCache = new Map<string, { available: boolean; code?: string; until: number }>();
/** Tests only: forget remembered probe results. */
export function resetProbeCache() { probeCache.clear(); }

/** Is the service usable right now? Never calls the generation endpoint. */
async function probe(deps: AskDependencies): Promise<{ available: boolean; code?: string }> {
  if (!deps.apiKey) return { available: false, code: "ask_not_configured" };
  const key = `${deps.apiKey.slice(-6)}:${deps.model}`;
  const now = Date.now();
  const hit = probeCache.get(key);
  if (hit && hit.until > now) return hit.code ? { available: hit.available, code: hit.code } : { available: hit.available };
  let result: { available: boolean; code?: string };
  try {
    const res = await deps.fetch(`${GEMINI}/${encodeURIComponent(deps.model)}`, {
      headers: { "x-goog-api-key": deps.apiKey }, signal: AbortSignal.timeout(5_000),
    });
    result = res.ok ? { available: true }
      : res.status === 429 ? { available: false, code: "quota" }
      : res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404 ? { available: false, code: "ask_not_configured" }
      : { available: false, code: "unavailable" };
  } catch {
    result = { available: false, code: "unavailable" };
  }
  probeCache.set(key, { ...result, until: now + (result.available ? 600_000 : 60_000) });
  return result;
}

/** The model call: a machine code on failure (quota = Google's 429, the free tier's daily limit). */
async function callModel(deps: AskDependencies, body: unknown): Promise<{ answer: AskModelAnswer; raw: unknown } | { error: string }> {
  let res: Response;
  try {
    res = await deps.fetch(`${GEMINI}/${encodeURIComponent(deps.model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": deps.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { error: "timeout" };
  }
  if (res.status === 429) return { error: "quota" };
  if (!res.ok) return { error: "unavailable" };
  try {
    const json = await res.json();
    const text = (json?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object" || typeof raw.intent !== "string") return { error: "bad_answer" };
    return { answer: raw as AskModelAnswer, raw };
  } catch {
    return { error: "bad_answer" };
  }
}

export async function handleAsk(req: Request, deps: AskDependencies): Promise<Response> {
  if (req.method === "OPTIONS") return response({ ok: true });
  if (req.method !== "POST") return failure("method_not_allowed", 405);
  const jwt = bearerToken(req);
  const profileId = jwt ? await deps.authenticate(jwt) : null;
  if (!jwt || !profileId) return failure("not_authorized", 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return failure("invalid_request", 400); }
  if (body?.probe === true) return response(await probe(deps));
  const departmentId = body?.department_id;
  const conversationId = body?.conversation_id ?? null;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  const draftOverride = body?.draft ?? null;
  if (typeof departmentId !== "string" || !uuid.test(departmentId)
    || (conversationId !== null && (typeof conversationId !== "string" || !uuid.test(conversationId)))
    || !message || message.length > 1000
    || (draftOverride !== null && (typeof draftOverride !== "object" || Array.isArray(draftOverride) || JSON.stringify(draftOverride).length > 8000))) {
    return failure("invalid_request", 400);
  }
  if (!deps.apiKey) return failure("ask_not_configured", 503);

  let row: AskContextRow;
  let begin: AskBegin;
  try {
    row = await deps.loadContext(jwt, departmentId);
    begin = await deps.beginTurn(profileId, departmentId, conversationId as string | null);
  } catch (e) {
    const code = codeOf(e);
    if (code && STATUS[code]) return failure(code, STATUS[code]);
    return failure("unavailable", 503);
  }

  const now = deps.now?.() ?? new Date();
  const { context, refs, people } = buildAskContext(row, now);
  const previous = (draftOverride as AskDraft | null) ?? begin.previous_draft;
  const started = Date.now();
  const result = await callModel(deps, buildGenerateRequest(context, message, { draft: previous, messages: begin.messages }));
  const latency = Date.now() - started;
  const draft = "answer" in result ? normalizeAnswer(result.answer, context, previous) : null;

  let turnId: string | null = null;
  try {
    turnId = await deps.recordTurn(begin.conversation_id, begin.position, {
      user_text: message, draft_in: previous, raw_answer: "raw" in result ? result.raw : null, draft,
      flags: draft?.flags ?? [], error: "error" in result ? result.error : null,
      prompt_version: PROMPT_VERSION, model: deps.model, latency_ms: latency,
    });
  } catch {
    // the member still gets their answer; a lost record is not worth failing the turn
  }
  if ("error" in result) return failure(result.error, 503, { conversation_id: begin.conversation_id });
  return response({ conversation_id: begin.conversation_id, turn_id: turnId, draft, refs, rides: context.my_rides, people });
}
