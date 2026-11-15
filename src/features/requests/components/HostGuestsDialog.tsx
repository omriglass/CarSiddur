import { useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { he, t, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";

import type { HostGuestDecision, HostGuestQuestion, HostGuestWarning } from "../api";

/** One screen of the dialog: a warning about a guest who may stay, or the one "cannot stay" notice. */
interface Step {
  guest: HostGuestQuestion;
  warning: HostGuestWarning | null;
}

/** Every guest's questions in order: a guest who may stay gets one per warning (far / detour / luggage). */
function stepsOf(guests: readonly HostGuestQuestion[] | null): Step[] {
  return (guests ?? []).flatMap((guest): Step[] => {
    if (guest.kind === "cannot") return [{ guest, warning: null }];
    const warnings = guest.warnings?.length ? guest.warnings : (["far"] as const);
    return warnings.map((warning) => ({ guest, warning }));
  });
}

/** R20 Q2 redo (owner-approved wording 2026-11-14): the question about one guest. */
function stepBody({ guest, warning }: Step): string {
  if (warning === null) {
    if (guest.reason === "seats") return tv("request.hostGuestSeatsBody", { name: guest.name });
    return tv("request.hostGuestCannotBody", { name: guest.name, reason: he.request.hostGuestReason[guest.reason ?? "other"] });
  }
  if (warning === "luggage") return tv("request.hostGuestLuggageBody", { name: guest.name });
  if (warning === "detour") return tv("request.hostGuestDetourBody", { name: guest.name, minutes: String(guest.added_minutes ?? 0) });
  const time = (at: string | null) => (at ? formatTime(new Date(at)) : "");
  return tv("request.hostGuestFarBody", { name: guest.name, wanted: time(guest.wanted_at), ride: time(guest.ride_at) });
}

export interface HostGuestsDialogProps {
  /** The guests the edit no longer fits (from `submit_request`'s `host_guests` question); null = closed. */
  guests: readonly HostGuestQuestion[] | null;
  /** Answers already given on an earlier attempt (kept when the server asks again). */
  initialDecisions?: Record<string, HostGuestDecision>;
  loading?: boolean;
  /** Every guest answered: send the edit again with these answers. */
  onAnswered: (decisions: Record<string, HostGuestDecision>) => void;
  /** "חזרה" (or closing): nothing is saved. */
  onBack: () => void;
}

/**
 * R20 Q2 redo (owner-approved wording 2026-11-14): an edit of a request that hosts a shared ride no longer fits a
 * guest — never dropped silently. One question at a time: a guest who may stay (far from their hours, a long detour,
 * no big trunk for their luggage) → keep on the ride / back to the waiting list / back, once per warning; a guest who
 * cannot stay → save anyway (back to waiting) / back. The edit is sent once, after the last answer.
 */
export function HostGuestsDialog({ guests, initialDecisions, loading = false, onAnswered, onBack }: HostGuestsDialogProps) {
  const [index, setIndex] = useState(0);
  const [decisions, setDecisions] = useState<Record<string, HostGuestDecision>>({});
  const [shownFor, setShownFor] = useState<readonly HostGuestQuestion[] | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  // a new question (another attempt) starts from its first guest
  if (guests !== shownFor) {
    setShownFor(guests);
    setSteps(stepsOf(guests));
    setIndex(0);
    setDecisions({ ...initialDecisions });
  }
  const step = steps[index] ?? null;
  const warn = step?.warning != null;
  const name = step?.guest.name ?? "";

  function answer(decision: HostGuestDecision) {
    if (!step) return;
    const id = step.guest.request_id;
    const next = { ...decisions, [id]: decision };
    // "keep" goes on to this guest's next warning; "release" ends this guest's questions
    let to = index + 1;
    if (decision === "release") while (to < steps.length && steps[to]?.guest.request_id === id) to += 1;
    if (to < steps.length) {
      setDecisions(next);
      setIndex(to);
      return;
    }
    onAnswered(next);
  }

  return (
    <ConfirmDialog
      open={!!step}
      onOpenChange={(open) => { if (!open) onBack(); }}
      title={t("request.hostGuestTitle")}
      description={step ? stepBody(step) : undefined}
      confirmLabel={warn ? tv("request.hostGuestKeep", { name }) : t("request.hostGuestSaveAnyway")}
      cancelLabel={t("request.hostGuestBack")}
      loading={loading}
      extraAction={warn ? (
        <Button type="button" variant="outline" className="min-h-11" disabled={loading} data-testid="host-guest-release"
          onClick={() => answer("release")}>
          {tv("request.hostGuestRelease", { name })}
        </Button>
      ) : undefined}
      onConfirm={() => answer(warn ? "keep" : "release")}
    />
  );
}
