// REQ §13.162 (a): "בטל נסיעה" on the board asks, for each request on the ride, whether it is still needed:
// "להשאיר ברשימת ההמתנה" (default) or "הנסיעה כבר לא רלוונטית" (the request is closed). Says plainly what closing means.
// O29-2 (3): on a merged ride every other request may also continue on it ("ממשיך/ה בנסיעה", their default).
import { useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { he, tv } from "@/i18n/he";

import {
  canContinue, choiceOf, closeRequestIds, continueRequestIds, nothingLeaves, type RideCancelChoice, type RideCancelLine,
} from "../rideCancelChoices";

export interface RideCancelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lines: readonly RideCancelLine[];
  /** A multi-day ride: the choice covers every day. */
  series?: boolean;
  /** R20H1: one day of a multi-day ride ("ד׳ 16.9") — the dialog asks "only this day / all days" (this day first). */
  seriesDay?: string | null;
  loading?: boolean;
  onConfirm: (reason: string, closeRequestIds: string[], continueRequestIds: string[], onlyDay: boolean) => void;
}

export function RideCancelDialog({ open, onOpenChange, lines, series, seriesDay, loading, onConfirm }: RideCancelDialogProps) {
  const [choices, setChoices] = useState<Record<string, RideCancelChoice>>({});
  const [reason, setReason] = useState("");
  const [scope, setScope] = useState<"day" | "all">("day");
  const onlyDay = !!seriesDay && scope === "day";
  const closing = closeRequestIds(lines, choices);
  const continuing = continueRequestIds(lines, choices);
  const blocked = nothingLeaves(lines, choices);
  function change(next: boolean) {
    if (!next) { setChoices({}); setReason(""); setScope("day"); }
    onOpenChange(next);
  }
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={change}
      title={seriesDay ? he.request.seriesCancelTitle : he.closeRequest.cancelTitle}
      description={lines.length ? he.closeRequest.cancelDescription : he.closeRequest.cancelNoRequests}
      confirmLabel={continuing.length ? he.closeRequest.cancelPartConfirm : he.closeRequest.cancelConfirm}
      destructive
      loading={loading}
      confirmDisabled={blocked}
      onConfirm={() => onConfirm(reason.trim(), closing, continuing, onlyDay)}
    >
      <div className="space-y-3" data-testid="ride-cancel-dialog">
        {seriesDay ? (
          <RadioGroup value={scope} onValueChange={(value) => setScope(value as "day" | "all")} className="gap-1.5" data-testid="ride-cancel-scope">
            <label className="flex min-h-11 items-center gap-2 rounded-md border p-1.5 text-sm font-medium">
              <RadioGroupItem value="day" data-testid="ride-cancel-only-day" />
              {tv("request.cancelOnlyDay", { day: seriesDay })}
            </label>
            <label className="flex min-h-11 items-center gap-2 rounded-md border p-1.5 text-sm font-medium">
              <RadioGroupItem value="all" data-testid="ride-cancel-all-days" />
              {he.request.cancelAllDays}
            </label>
          </RadioGroup>
        ) : null}
        {series && !onlyDay && lines.length ? <p className="text-sm text-muted-foreground">{he.closeRequest.seriesNote}</p> : null}
        {lines.map((line) => (
          <fieldset key={line.requestId} className="space-y-1.5 rounded-md border p-2" data-testid="ride-cancel-line" data-request-id={line.requestId}>
            <legend className="px-1 text-sm font-semibold">{line.name || he.deviations.noName}</legend>
            <RadioGroup value={choiceOf(choices, line.requestId, lines)} className="gap-1.5"
              onValueChange={(value) => setChoices((current) => ({ ...current, [line.requestId]: value as RideCancelChoice }))}>
              {canContinue(lines) ? (
                <label className="flex min-h-11 items-start gap-2 rounded-md p-1.5 text-sm">
                  <RadioGroupItem value="continue" className="mt-0.5" data-testid="ride-cancel-continue" />
                  <span><span className="font-medium">{he.closeRequest.continueOption}</span><span className="block text-xs text-muted-foreground">{he.closeRequest.continueHint}</span></span>
                </label>
              ) : null}
              <label className="flex min-h-11 items-start gap-2 rounded-md p-1.5 text-sm">
                <RadioGroupItem value="keep" className="mt-0.5" data-testid="ride-cancel-keep" />
                <span><span className="font-medium">{he.closeRequest.keepOption}</span><span className="block text-xs text-muted-foreground">{he.closeRequest.keepHint}</span></span>
              </label>
              <label className="flex min-h-11 items-start gap-2 rounded-md p-1.5 text-sm">
                <RadioGroupItem value="close" className="mt-0.5" data-testid="ride-cancel-close" />
                <span><span className="font-medium">{he.closeRequest.closeOption}</span><span className="block text-xs text-muted-foreground">{he.closeRequest.closeHint}</span></span>
              </label>
            </RadioGroup>
          </fieldset>
        ))}
        {blocked ? <p className="text-sm text-muted-foreground" data-testid="ride-cancel-nothing">{he.closeRequest.nothingLeaves}</p>
          : continuing.length ? <p className="text-sm text-muted-foreground" data-testid="ride-cancel-kept-note">{he.closeRequest.rideKeptNote}</p> : null}
        {closing.length ? (
          <p role="alert" className="rounded-md border border-destructive/50 bg-destructive/5 p-2 text-sm font-medium text-destructive" data-testid="ride-cancel-close-warning">
            {he.closeRequest.closeWarning}
          </p>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor="ride-cancel-reason">{he.closeRequest.reasonLabel}</Label>
          <Textarea id="ride-cancel-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder={he.closeRequest.reasonPlaceholder} />
          {closing.length ? <p className="text-xs text-muted-foreground">{he.closeRequest.reasonHint}</p> : null}
        </div>
      </div>
    </ConfirmDialog>
  );
}
