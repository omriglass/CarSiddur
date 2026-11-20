import { createClient } from "npm:@supabase/supabase-js@2";
import { optionalEnv, requireEnv } from "../_shared/env.ts";
import { getServiceRoleClient, getUserFromJwt } from "../_shared/supabaseAdmin.ts";
import type { AskContextRow } from "../_shared/askContext.ts";
import { AskError, handleAsk, type AskBegin } from "./handler.ts";

/** Default model (REQ item 258 e: "the model is a setting" — the ASK_MODEL secret overrides it). */
const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const CODES = ["not_authorized", "not_found", "conversation_ended", "daily_limit", "conversation_too_long"];

function caller(jwt: string) {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
function rpcError(error: { message?: string }): Error {
  const code = CODES.find((c) => error.message === c);
  return code ? new AskError(code) : new Error(error.message ?? "rpc_failed");
}

Deno.serve((req: Request) => handleAsk(req, {
  authenticate: async (jwt) => (await getUserFromJwt(jwt))?.id ?? null,
  loadContext: async (jwt, departmentId) => {
    const { data, error } = await caller(jwt).rpc("ask_context", { p_department_id: departmentId });
    if (error) throw rpcError(error);
    return data as AskContextRow;
  },
  beginTurn: async (profileId, departmentId, conversationId) => {
    const { data, error } = await getServiceRoleClient().rpc("ask_begin_turn",
      { p_profile_id: profileId, p_department_id: departmentId, p_conversation_id: conversationId });
    if (error) throw rpcError(error);
    return data as AskBegin;
  },
  recordTurn: async (conversationId, position, turn) => {
    const { data, error } = await getServiceRoleClient().rpc("ask_record_turn",
      { p_conversation_id: conversationId, p_position: position, p_turn: turn });
    if (error) throw rpcError(error);
    return data as string;
  },
  apiKey: optionalEnv("GEMINI_API_KEY"),
  model: optionalEnv("ASK_MODEL", DEFAULT_MODEL),
  fetch,
}));
