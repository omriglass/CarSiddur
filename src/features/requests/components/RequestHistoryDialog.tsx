import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { he } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { formatTime } from "@/lib/time";

import { useRequestHistory } from "../hooks";
import { requestTimeline } from "../requestTimeline";

/** REQ §13.204: one request's story, oldest first — fetched only while shown. */
export function RequestTimeline({ requestId, enabled = true }: { requestId: string; enabled?: boolean }) {
  const history = useRequestHistory(requestId, enabled);
  if (history.isLoading) return <p className="text-sm text-muted-foreground">{he.requestHistory.loading}</p>;
  if (history.isError) return <p role="alert" className="text-sm">{he.requestHistory.loadError}</p>;
  const lines = requestTimeline(history.data ?? []);
  if (!lines.length) return <p className="text-sm text-muted-foreground">{he.requestHistory.empty}</p>;
  return (
    <ol className="space-y-2 text-sm" data-testid="request-timeline">
      {lines.map((line) => (
        <li key={line.key} className="border-s-2 ps-3" data-testid="request-timeline-line">
          <p className="text-xs text-muted-foreground">
            <span dir="ltr">{formatDayDate(line.at)} {formatTime(new Date(line.at))}</span>
            {line.actor ? <> · {line.actor}</> : null}
          </p>
          <p>{line.what}</p>
          {line.detail ? <p className="whitespace-pre-wrap text-xs text-muted-foreground">{line.detail}</p> : null}
        </li>
      ))}
    </ol>
  );
}

export interface RequestHistoryDialogProps {
  requestId: string;
  /** Shown under the title: whose request, which day. */
  subtitle?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Read-only, no footer: the member's "what happened?" and the Sadran's "request history". */
export function RequestHistoryDialog({ requestId, subtitle, open, onOpenChange }: RequestHistoryDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto" data-testid="request-history-dialog">
        <DialogHeader>
          <DialogTitle>{he.requestHistory.title}</DialogTitle>
          {subtitle ? <DialogDescription>{subtitle}</DialogDescription> : null}
        </DialogHeader>
        <RequestTimeline requestId={requestId} enabled={open} />
      </DialogContent>
    </Dialog>
  );
}
