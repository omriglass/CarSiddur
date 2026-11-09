import { useState } from "react";

import { Button } from "@/components/ui/button";
import { he, tv } from "@/i18n/he";
import { describeStatusReason } from "@/lib/statusReason";

import { whenLabel } from "../requestTimeline";
import { RequestHistoryDialog } from "./RequestHistoryDialog";

import type { ClosedRequestRow } from "../api";

function rowLine(row: ClosedRequestRow): string {
  return [whenLabel(row.departAt, row.returnAt), row.destination].filter(Boolean).join(" · ");
}

/**
 * REQ §13.204 (d): withdrawn / cancelled / closed requests, one light row each — what it was, why it closed, and
 * "what happened?" for its whole story. No other actions: a closed request is history.
 */
export function ClosedRequestsList({ rows }: { rows: readonly ClosedRequestRow[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = rows.find((row) => row.id === openId);
  return (
    <>
      <ul className="space-y-1.5" data-testid="closed-requests">
        {rows.map((row) => (
          <li key={row.id} className="flex items-start justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm" data-closed-request={row.id}>
            <div className="min-w-0 space-y-0.5">
              <p className="text-muted-foreground line-through decoration-muted-foreground/50">{rowLine(row)}</p>
              <p className="text-xs">
                {describeStatusReason(row.statusReason) ?? he.status[row.status]}
                {row.requesterName ? <> · {tv("request.filedFor", { name: row.requesterName })}</> : null}
              </p>
            </div>
            <Button type="button" variant="link" size="sm" className="min-h-11 shrink-0 px-1" onClick={() => setOpenId(row.id)} data-testid="closed-request-history">
              {he.requestHistory.open}
            </Button>
          </li>
        ))}
      </ul>
      {open ? (
        <RequestHistoryDialog requestId={open.id} subtitle={rowLine(open)} open onOpenChange={(value) => { if (!value) setOpenId(null); }} />
      ) : null}
    </>
  );
}
