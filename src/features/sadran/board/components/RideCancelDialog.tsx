// REQ §13.162 (a): "בטל נסיעה" on the board asks, for each request on the ride, whether it is still needed:
// "להשאיר ברשימת ההמתנה" (default) or "הנסיעה כבר לא רלוונטית" (the request is closed). Says plainly what closing means.
import { useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { he } from "@/i18n/he";

import { choiceOf, closeRequestIds, type RideCancelChoice, type RideCancelLine } from "../rideCancelChoices";

export interface RideCancelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lines: readonly RideCancelLine[];
  /** A multi-day ride: the choice covers every day. */
  series?: boolean;
  loading?: boolean;
  onConfirm: (reason: string, closeRequestIds: string[]) => void;
}

export function RideCancelDialog({ open, onOpenChange, lines, series, loading, onConfirm }: RideCancelDialogProps) {
  const [choices, setChoices] = useState<Record<string, RideCancelChoice>>({});
  const [reason, setReason] = useState("");
  const closing = closeRequestIds(lines, choices);
  function change(next: boolean) {
    if (!next) { setChoices({}); setReason(""); }
    onOpenChange(next);
  }
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={change}
      title={he.closeRequest.cancelTitle}
      description={lines.length ? he.closeRequest.cancelDescription : he.closeRequest.cancelNoRequests}
      confirmLabel={he.closeRequest.cancelConfirm}
      destructive
      loading={loading}
      onConfirm={() => onConfirm(reason.trim(), closing)}
    >
      <div className="space-y-3" data-testid="ride-cancel-dialog">
        {series && lines.length ? <p className="text-sm text-muted-foreground">{he.closeRequest.seriesNote}</p> : null}
        {lines.map((line) => (
          <fieldset key={line.requestId} className="space-y-1.5 rounded-md border p-2" data-testid="ride-cancel-line" data-request-id={line.requestId}>
            <legend className="px-1 text-sm font-semibold">{line.name || he.deviations.noName}</legend>
            <RadioGroup value={choiceOf(choices, line.requestId)} className="gap-1.5"
              onValueChange={(value) => setChoices((current) => ({ ...current, [line.requestId]: value as RideCancelChoice }))}>
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
