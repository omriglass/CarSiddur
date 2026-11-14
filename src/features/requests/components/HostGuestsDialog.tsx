import { useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { he, t, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";

import type { HostGuestDecision, HostGuestQuestion } from "../api";

/** R20 Q2 redo: the question about one guest — far from their own hours, or unable to stay (and why). */
function hostGuestBody(guest: HostGuestQuestion): string {
  if (guest.kind === "cannot") {
    return tv("request.hostGuestCannotBody", { name: guest.name, reason: he.request.hostGuestReason[guest.reason ?? "other"] });
  }
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
 * guest — never dropped silently. One guest at a time: far from their hours → keep on the ride / back to the waiting
 * list / back; cannot stay → save anyway (back to waiting) / back. The edit is sent once, after the last answer.
 */
export function HostGuestsDialog({ guests, initialDecisions, loading = false, onAnswered, onBack }: HostGuestsDialogProps) {
  const [index, setIndex] = useState(0);
  const [decisions, setDecisions] = useState<Record<string, HostGuestDecision>>({});
  const [shownFor, setShownFor] = useState<readonly HostGuestQuestion[] | null>(null);
  // a new question (another attempt) starts from its first guest
  if (guests !== shownFor) {
    setShownFor(guests);
    setIndex(0);
    setDecisions({ ...initialDecisions });
  }
  const guest = guests?.[index] ?? null;
  const far = guest?.kind === "far";

  function answer(decision: HostGuestDecision) {
    if (!guests || !guest) return;
    const next = { ...decisions, [guest.request_id]: decision };
    if (index + 1 < guests.length) {
      setDecisions(next);
      setIndex(index + 1);
      return;
    }
    onAnswered(next);
  }

  return (
    <ConfirmDialog
      open={!!guest}
      onOpenChange={(open) => { if (!open) onBack(); }}
      title={t("request.hostGuestTitle")}
      description={guest ? hostGuestBody(guest) : undefined}
      confirmLabel={far ? tv("request.hostGuestKeep", { name: guest?.name ?? "" }) : t("request.hostGuestSaveAnyway")}
      cancelLabel={t("request.hostGuestBack")}
      loading={loading}
      extraAction={far ? (
        <Button type="button" variant="outline" className="min-h-11" disabled={loading} data-testid="host-guest-release"
          onClick={() => answer("release")}>
          {tv("request.hostGuestRelease", { name: guest?.name ?? "" })}
        </Button>
      ) : undefined}
      onConfirm={() => answer(far ? "keep" : "release")}
    />
  );
}
