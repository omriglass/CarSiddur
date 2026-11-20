// REQ item 258 (AI1): the only place the Ask-in-words feature calls Supabase (the `ask` edge function and its RPCs).
import { supabase } from "@/integrations/supabase/client";
import { rpc, toAppError } from "@/lib/rpc";

import type { AskDraft, AskErrorCode, AskTurnResult } from "./types";

export interface AskAccess { hidden: boolean; disclaimerAckAt: string | null }

/** The member's own opt-in row (RLS: own or admin); null = not opted in by an admin. */
export async function fetchAskAccess(profileId: string): Promise<AskAccess | null> {
  const { data, error } = await supabase.from("ask_access").select("hidden, disclaimer_ack_at").eq("profile_id", profileId).maybeSingle();
  if (error) throw toAppError(error);
  return data ? { hidden: data.hidden, disclaimerAckAt: data.disclaimer_ack_at } : null;
}

/** A failed turn: the function's machine code (worded by the app), and the conversation it belonged to. */
export class AskTurnError extends Error {
  constructor(readonly code: AskErrorCode | "network", readonly conversationId: string | null = null) { super(code); }
}

async function functionError(error: { context?: unknown }): Promise<AskTurnError> {
  if (error.context instanceof Response) {
    try {
      const body = await error.context.json();
      return new AskTurnError(body?.error?.code ?? "unavailable", body?.conversation_id ?? null);
    } catch { /* a gateway error has no function payload */ }
  }
  return new AskTurnError("network");
}

/** Is the service usable now (key set, accepted, quota left)? Never spends generation quota. */
export async function probeAsk(): Promise<{ available: boolean; code?: string }> {
  const { data, error } = await supabase.functions.invoke("ask", { body: { probe: true } });
  if (error) return { available: false, code: (await functionError(error)).code };
  return { available: data?.available === true, code: data?.code };
}

export async function sendAskTurn(input: {
  departmentId: string; message: string; conversationId: string | null; draft?: AskDraft | null;
}): Promise<AskTurnResult> {
  const { data, error } = await supabase.functions.invoke("ask", {
    body: {
      department_id: input.departmentId,
      message: input.message,
      ...(input.conversationId ? { conversation_id: input.conversationId } : {}),
      ...(input.draft ? { draft: input.draft } : {}),
    },
  });
  if (error) throw await functionError(error);
  return data as AskTurnResult;
}

export const setMyAskHidden = (hidden: boolean) => rpc("set_my_ask_hidden", { p_hidden: hidden });
export const ackAskDisclaimer = () => rpc("ack_ask_disclaimer", undefined as never);
export const markAskTurn = (turnId: string, thumbsDown: boolean) => rpc("mark_ask_turn", { p_turn_id: turnId, p_thumbs_down: thumbsDown });
export const adminSetAskAccess = (profileId: string, enabled: boolean) => rpc("admin_set_ask_access", { p_profile_id: profileId, p_enabled: enabled });

export type AskOutcome = "to_form" | "done" | "cancelled" | "closed";
export function finishAskConversation(conversationId: string, outcome: AskOutcome, extra: { requestId?: string; sent?: unknown; diff?: unknown } = {}) {
  return rpc("finish_ask_conversation", {
    p_conversation_id: conversationId,
    p_outcome: outcome,
    ...(extra.requestId ? { p_request_id: extra.requestId } : {}),
    ...(extra.sent !== undefined ? { p_sent: extra.sent as never } : {}),
    ...(extra.diff !== undefined ? { p_diff: extra.diff as never } : {}),
  });
}
