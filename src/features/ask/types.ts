// REQ item 258 (AI1): the `ask` edge function's answer as the app reads it. The draft's shape is the function's own
// (`supabase/functions/_shared/askNormalize.ts`, type-only import — one definition on both sides).
import type { AskDraft } from "../../../supabase/functions/_shared/askNormalize";
import type { AskPersonRef } from "../../../supabase/functions/_shared/askContext";
import type { AskRide } from "../../../supabase/functions/_shared/askPrompt";

export type { AskDraft, AskPersonRef, AskRide };
export type { AskIntent, AskQuestion, AskPlaceRef } from "../../../supabase/functions/_shared/askNormalize";

export interface AskTurnResult {
  conversation_id: string;
  turn_id: string | null;
  draft: AskDraft;
  /** RIDE_n → request id */
  refs: Record<string, string>;
  rides: AskRide[];
  people: Record<string, AskPersonRef | null>;
}

/** What the chat hands the regular form (router state): the form fills itself from it and reports back on submit. */
export interface AskFormHandoff {
  conversationId: string;
  draft: AskDraft;
  people: Record<string, AskPersonRef | null>;
  /** The card's one-line summary, shown on top of the form. */
  summary: string;
}

/** The Ask-in-words error codes the function answers with (REQ item 258; no Hebrew on the server). */
export type AskErrorCode =
  | "not_authorized" | "invalid_request" | "daily_limit" | "conversation_too_long" | "conversation_ended" | "not_found"
  | "quota" | "timeout" | "unavailable" | "bad_answer" | "ask_not_configured";
