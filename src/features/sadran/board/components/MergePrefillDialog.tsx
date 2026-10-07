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

import { mergeLegOptions, type MergeLeg, type MergePreview, type MergeVerdict } from "../mergeProposal";
import { requestFlexLines } from "../mergeFlex";

import type { ComposerPrefill as MergePrefill } from "../draftInput";
import type { WeekRequestRow } from "../../api";

type FlexSource = Parameters<typeof requestFlexLines>[0];

/** REQ §13.101 (k): the other ride of a connected הקפצה pair the "both ways" merge also joins. */
export interface MergePairRide {
  label: string;
  startsAt?: string | null;
  endsAt?: string | null;
  preview: MergePreview | null;
}

export interface MergePrefillDialogProps {
  prefill: MergePrefill | null;
  /** The base ride's board label. */
  hostLabel: string | null | undefined;
  /** The base ride's own window (before the merge). */
  hostStartsAt?: string | null;
  hostEndsAt?: string | null;
  request: (Pick<WeekRequestRow, "trip_shape" | "requester_full_name" | "depart_at" | "return_at"> & FlexSource) | undefined;
  /** REQ §13.101 (QU5): the base ride's own requester (flexibility shown next to the base). */
  hostRequest?: (Pick<WeekRequestRow, "requester_full_name"> & FlexSource) | null;
  /** REQ §13.101 (k): second ride of a connected pair, previewed with its own leg. */
  pair?: MergePairRide | null;
  /** "מ<origin> ל<destination> · <trip type>" of the added request. */
  requestRoute: string;
  leg: MergeLeg;
  onLegChange: (leg: MergeLeg) => void;
  /** The card's own leg (a return-leg card offers "חזור בלבד", REQ §13.102). */
  anchorLeg?: "out" | "return" | null;
  /**
   * REQ item 108 (M1): the server's verdict (`merge_preview`) per leg the popup offers; a leg that is
   * refused or still being checked is disabled.
   */
  legVerdicts?: Partial<Record<MergeLeg, MergeVerdict>>;
  /** The server's verdict for the selected leg(s): refused -> its reason is shown and send/draft are disabled; loading -> disabled. */
  verdict?: MergeVerdict;
  /** REQ §13.102 (d): out on one ride and return on another, one proposal - leg choice hidden. */
  split?: boolean;
  /** How this merge relates to the request's open draft. */
  draftNote?: "extends" | "replaces" | null;
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

function FlexLines({ request, testId }: { request: FlexSource; testId: string }) {
  const lines = requestFlexLines(request);
  return (
    <p className="text-xs text-muted-foreground" data-testid={testId}>
      {he.mergedRide.flexLabel} · {tv("mergedRide.flexDepart", { value: lines.depart })}
      {lines.return ? ` · ${tv("mergedRide.flexReturn", { value: lines.return })}` : ""}
    </p>
  );
}

interface RideBlockProps {
  testId: string;
  heading: string;
  label: string | null | undefined;
  startsAt?: string | null;
  endsAt?: string | null;
  preview: MergePreview | null;
  flex?: ({ requester_full_name?: string | null } & FlexSource) | null;
}

function RideBlock({ testId, heading, label, startsAt, endsAt, preview, flex }: RideBlockProps) {
  return (
    <div data-testid={testId}>
      <p className="text-xs text-muted-foreground">{heading}</p>
      <p className="font-medium">{label}</p>
      {startsAt && endsAt ? (
        <p>
          <span dir="ltr" className="tabular-nums">{formatTime(new Date(startsAt))}–{formatTime(new Date(endsAt))}</span>
        </p>
      ) : null}
      {flex ? <FlexLines request={flex} testId={`${testId}-flex`} /> : null}
      {preview?.valid && startsAt && formatTime(new Date(preview.startsAt)) !== formatTime(new Date(startsAt)) ? (
        <p className="font-semibold text-maintenance" data-testid={testId === "merge-base" ? "merge-departs-earlier" : `${testId}-departs-earlier`}>
          {tv("mergedRide.departsAt", { time: formatTime(new Date(preview.startsAt)), old: formatTime(new Date(startsAt)) })}
        </p>
      ) : null}
      {preview?.valid && endsAt && formatTime(new Date(preview.endsAt)) !== formatTime(new Date(endsAt)) ? (
        <p className="font-semibold text-maintenance" data-testid={testId === "merge-base" ? "merge-ends-later" : `${testId}-ends-later`}>
          {tv("mergedRide.endsLater", { time: formatTime(new Date(preview.endsAt)), old: formatTime(new Date(endsAt)) })}
        </p>
      ) : null}
    </div>
  );
}

export function MergePrefillDialog({ prefill, hostLabel, hostStartsAt, hostEndsAt, request, hostRequest, pair, requestRoute, leg, onLegChange, anchorLeg, legVerdicts, verdict, split, draftNote, preview, onConfirm, onDraft, busy, onCancel }: MergePrefillDialogProps) {
  const options = request && !split ? mergeLegOptions(request, anchorLeg) : null;
  // The server decides; without a verdict (no host/request to ask about) the TS twin's validity is the fallback.
  const blocked = verdict ? verdict.status !== "ok" : (!!preview && !preview.valid) || (!!pair?.preview && !pair.preview.valid);
  return (
    <Dialog open={!!prefill} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent data-testid="merge-dialog">
        <DialogHeader>
          <DialogTitle>{he.boardCoordination.mergeTitle}</DialogTitle>
          <DialogDescription>{he.boardCoordination.mergeHelp}</DialogDescription>
        </DialogHeader>
        {prefill ? (
          <div className="space-y-3 rounded-md border p-3 text-sm">
            {draftNote ? <p className="text-xs font-semibold text-maintenance" data-testid="merge-draft-note">{draftNote === "extends" ? he.mergedRide.draftExtends : he.mergedRide.draftReplaces}</p> : null}
            {split ? <p className="text-xs text-muted-foreground" data-testid="merge-split-note">{he.mergedRide.splitNote}</p> : null}
            <RideBlock testId="merge-base" heading={split ? he.mergedRide.splitHeadingOut : he.mergedRide.base} label={hostLabel} startsAt={hostStartsAt} endsAt={hostEndsAt} preview={preview} flex={hostRequest} />
            {pair ? (
              <RideBlock testId="merge-pair" heading={split ? he.mergedRide.splitHeadingReturn : he.mergedRide.pairHeading} label={pair.label} startsAt={pair.startsAt} endsAt={pair.endsAt} preview={pair.preview} />
            ) : null}
            <div data-testid="merge-added">
              <p className="text-xs text-muted-foreground">{he.mergedRide.added}</p>
              <p className="font-medium">{request?.requester_full_name}</p>
              <p className="text-muted-foreground">{requestRoute}</p>
              {request ? <FlexLines request={request} testId="merge-added-flex" /> : null}
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
                        disabled={!!legVerdicts?.[choice] && legVerdicts[choice]!.status !== "ok"}
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
            {verdict?.status === "refused" ? (
              <p className="font-semibold text-destructive" data-testid="merge-invalid" data-code={verdict.code ?? undefined}>{verdict.message}</p>
            ) : verdict?.status === "loading" ? (
              <p className="text-muted-foreground" data-testid="merge-checking" role="status">{he.mergedRide.checking}</p>
            ) : preview?.boardEta ? (
              <div data-testid="merge-eta" className="space-y-0.5">
                <p>{he.mergedRide.estimated}</p>
                {([["out", preview.joinerOutAt, request?.depart_at, "mergedRide.joinerOut"], ["return", preview.joinerReturnAt, request?.return_at, "mergedRide.joinerReturn"]] as const).map(([side, at, old, key]) => at ? (
                  <p key={side} data-testid={`merge-joiner-${side}`}>
                    {tv(key, { time: old && formatTime(new Date(old)) !== formatTime(new Date(at)) ? tv("mergedRide.joinerChanged", { time: formatTime(new Date(at)), old: formatTime(new Date(old)) }) : formatTime(new Date(at)) })}
                  </p>
                ) : null)}
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
          <Button onClick={onConfirm} disabled={busy || blocked} className="min-h-11" data-testid="merge-prepare">{he.boardDrafts.prepare}</Button>
          <Button variant="secondary" onClick={onDraft} disabled={busy || blocked} className="min-h-11" data-testid="merge-save-draft">{he.boardDrafts.draftButton}</Button>
          <Button variant="outline" onClick={onCancel} className="min-h-11">{he.common.cancel}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
