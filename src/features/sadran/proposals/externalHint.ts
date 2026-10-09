export const EXTERNAL_HINTS = ["cab", "rental", "public_transport", "private", "waive"] as const;
export type ExternalHint = (typeof EXTERNAL_HINTS)[number];

/**
 * R7U3: the solver names its suggestion `publicTransport` (camelCase), the proposal payload, the SQL text fragments
 * (`external.hint.public_transport`) and the composer's select use `public_transport`. Without this mapping a public-transport
 * suggestion fell through to the select's first option (taxi) and the text asked the wrong question.
 */
export function externalHintFromSuggestion(hint: string | undefined | null): ExternalHint {
  if (hint === "publicTransport") return "public_transport";
  return (EXTERNAL_HINTS as readonly string[]).includes(hint ?? "") ? (hint as ExternalHint) : "cab";
}

/** The hint the unmet card's generic "solve outside" button opens the composer with: the card's own first external suggestion, else a taxi. */
export function externalHintForCard(suggestions: readonly { kind: string; hint?: string }[] | undefined): ExternalHint {
  const first = suggestions?.find((s) => s.kind === "externalHint");
  return externalHintFromSuggestion(first?.hint);
}
