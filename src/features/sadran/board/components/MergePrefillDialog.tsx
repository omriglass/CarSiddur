// REQ §13.94 (G10): the merge popup. The merge makes ONE ride: the base keeps its start, the
// added person's boarding/alighting join its route and the end grows only by the added driving.
// Shows the base ride and time, the added person and their route, the leg choice ("הלוך בלבד" /
// "הלוך וחזור" - preset and read-only when the request is itself one-leg), the estimated time at
// their stop ("השעה תשתנה ל-HH:MM" when it differs from the requested one) and the three actions
// טיוטה / הכן הצעה / ביטול.
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { he, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";

import { mergeLegOptions, type MergeLeg, type MergePreview } from "../mergeProposal";

import type { ComposerPrefill as MergePrefill } from "../draftInput";
import type { WeekRequestRow } from "../../api";

export interface MergePrefillDialogProps {
  prefill: MergePrefill | null;
  /** The base ride's board label. */
  hostLabel: string | null | undefined;
  /** The base ride's own window (before the merge). */
  hostStartsAt?: string | null;
  hostEndsAt?: string | null;
  request: Pick<WeekRequestRow, "trip_shape" | "requester_full_name"> | undefined;
  /** "מ<origin> ל<destination> · <trip type>" of the added request. */
  requestRoute: string;
  leg: MergeLeg;
  onLegChange: (leg: MergeLeg) => void;
  /** The merged ride (route twin); `null` when it cannot be computed. */
  preview: MergePreview | null;
  onConfirm: () => void;
  /** REQ §13.94: store the merge as an unsent draft and stay on the board. */
  onDraft: () => void;
  busy?: boolean;
  onCancel: () => void;
}

const LEG_LABEL: Record<MergeLeg, string> = {
  out: he.mergedRide.legOut,
  both: he.mergedRide.legBoth,
  return: he.mergedRide.legReturn,
};

function Time({ iso }: { iso: string }) {
  return <span dir="ltr" className="tabular-nums">{formatTime(new Date(iso))}</span>;
}

export function MergePrefillDialog({ prefill, hostLabel, hostStartsAt, hostEndsAt, request, requestRoute, leg, onLegChange, preview, onConfirm, onDraft, busy, onCancel }: MergePrefillDialogProps) {
  const options = request ? mergeLegOptions(request) : null;
  return (
    <Dialog open={!!prefill} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent data-testid="merge-dialog">
        <DialogHeader>
          <DialogTitle>{he.boardCoordination.mergeTitle}</DialogTitle>
          <DialogDescription>{he.boardCoordination.mergeHelp}</DialogDescription>
        </DialogHeader>
        {prefill ? (
          <div className="space-y-3 rounded-md border p-3 text-sm">
            <div data-testid="merge-base">
              <p className="text-xs text-muted-foreground">{he.mergedRide.base}</p>
              <p className="font-medium">{hostLabel}</p>
              {hostStartsAt && hostEndsAt ? (
                <p>
                  <span dir="ltr" className="tabular-nums">{formatTime(new Date(hostStartsAt))}–{formatTime(new Date(hostEndsAt))}</span>
                </p>
              ) : null}
              {preview?.valid && hostStartsAt && preview.startsAt !== hostStartsAt ? (
                <p className="font-semibold text-maintenance" data-testid="merge-departs-earlier">
                  {tv("mergedRide.departsAt", { time: formatTime(new Date(preview.startsAt)), old: formatTime(new Date(hostStartsAt)) })}
                </p>
              ) : null}
              {preview?.valid && hostEndsAt && preview.endsAt !== hostEndsAt ? (
                <p className="font-semibold text-maintenance" data-testid="merge-ends-later">
                  {tv("mergedRide.endsLater", { time: formatTime(new Date(preview.endsAt)), old: formatTime(new Date(hostEndsAt)) })}
                </p>
              ) : null}
            </div>
            <div data-testid="merge-added">
              <p className="text-xs text-muted-foreground">{he.mergedRide.added}</p>
              <p className="font-medium">{request?.requester_full_name}</p>
              <p className="text-muted-foreground">{requestRoute}</p>
            </div>
            {options ? (
              <div data-testid="merge-legs">
                <p className="text-xs text-muted-foreground">{he.mergedRide.legLabel}</p>
                {options.choices.length > 1 ? (
                  <div role="radiogroup" aria-label={he.mergedRide.legLabel} className="flex gap-2">
                    {options.choices.map((choice) => (
                      <Button
                        key={choice}
                        type="button"
                        role="radio"
                        aria-checked={leg === choice}
                        variant={leg === choice ? "default" : "outline"}
                        className={cn("min-h-11 flex-1")}
                        data-testid={`merge-leg-${choice}`}
                        onClick={() => onLegChange(choice)}
                      >
                        {LEG_LABEL[choice]}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <p className="font-medium" data-testid="merge-leg-fixed">{LEG_LABEL[options.choices[0]!]}</p>
                )}
              </div>
            ) : null}
            {preview && !preview.valid && preview.invalid ? (
              <p className="font-semibold text-destructive" data-testid="merge-invalid">{he.mergedRide.invalid[preview.invalid]}</p>
            ) : preview?.boardEta ? (
              <div data-testid="merge-eta" className="space-y-0.5">
                <p>{he.mergedRide.estimated} <Time iso={preview.boardEta} /></p>
                {preview.timeChanges ? (
                  <p className="font-semibold text-maintenance" data-testid="merge-time-changes">{he.mergedRide.timeChanges}<Time iso={preview.boardEta} /></p>
                ) : null}
              </div>
            ) : (
              <p className="text-muted-foreground">{he.mergedRide.noRoute}</p>
            )}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button onClick={onConfirm} disabled={busy || (!!preview && !preview.valid)} className="min-h-11" data-testid="merge-prepare">{he.boardDrafts.prepare}</Button>
          <Button variant="secondary" onClick={onDraft} disabled={busy || (!!preview && !preview.valid)} className="min-h-11" data-testid="merge-save-draft">{he.boardDrafts.draftButton}</Button>
          <Button variant="outline" onClick={onCancel} className="min-h-11">{he.common.cancel}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
