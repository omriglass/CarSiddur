// REQ item 258 (d): the chat's handoff turned into what `RequestForm` applies — on a new form's empty values, or on
// the edited request's loaded values. `understood` = the fields the chat set (the "what was finally sent" diff).
import type { RequestFormValues } from "@/features/requests/schema";

import { applyDraftEdit, draftToNewRequest, type AskCatalog } from "./draftToForm";
import type { AskFormHandoff } from "./types";

export interface AskPrefill {
  conversationId: string;
  summary: string;
  apply: (values: RequestFormValues) => { values: RequestFormValues; understood: Partial<RequestFormValues> };
}

export function newRequestPrefill(handoff: AskFormHandoff, destinations: AskCatalog["destinations"]): AskPrefill {
  const { patch } = draftToNewRequest(handoff.draft, { destinations, people: handoff.people });
  return {
    conversationId: handoff.conversationId,
    summary: handoff.summary,
    apply: (values) => ({ values: { ...values, ...patch }, understood: patch }),
  };
}

export function editPrefill(handoff: AskFormHandoff, destinations: AskCatalog["destinations"]): AskPrefill {
  return {
    conversationId: handoff.conversationId,
    summary: handoff.summary,
    apply: (values) => {
      const next = applyDraftEdit(values, handoff.draft, { destinations, people: handoff.people }).values;
      const understood = Object.fromEntries(
        (Object.keys(next) as (keyof RequestFormValues)[])
          .filter((key) => JSON.stringify(next[key] ?? null) !== JSON.stringify(values[key] ?? null))
          .map((key) => [key, next[key]]),
      ) as Partial<RequestFormValues>;
      return { values: next, understood };
    },
  };
}

/** The handoff in router state (`navigate(…, { state: { from, ask } })`), checked loosely: it is our own object. */
export function readAskHandoff(state: unknown): AskFormHandoff | null {
  if (!state || typeof state !== "object") return null;
  const ask = (state as { ask?: AskFormHandoff }).ask;
  return ask && typeof ask.conversationId === "string" && ask.draft && typeof ask.draft === "object" ? ask : null;
}
