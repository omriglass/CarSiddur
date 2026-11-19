import { CalendarClock, Check, Pencil } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { FormDialog } from "@/components/FormDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PortalDialogContent } from "@/components/PortalDialogContent";
import { Textarea } from "@/components/ui/textarea";
import { MaintenancePeriodDialog } from "@/features/fleet/components/MaintenancePeriodDialog";
import { he } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { showErrorToast } from "@/lib/rpc";

import { useUpdateCarIssueMutation } from "../hooks";

export interface IssueTarget {
  id: string;
  description: string;
  createdAt: string;
  isUnsafe: boolean;
}

interface Props {
  car: { id: string; name: string };
  issue: IssueTarget | null;
  onClose: () => void;
  /** The car's managers and the department's Sadran (`update_car_issue` re-checks): resolve, reword, schedule. */
  canManage: boolean;
  /** The reporter of an open issue may reword it. */
  canReword: boolean;
}

/**
 * CR2 (REQ item 257 b, owner 2026-11-20): an open issue tapped on the car page (the banner or the history) —
 * "סימון כטופל", "עריכת הניסוח", "קביעת טיפול" (the maintenance dialog, the issue's wording as its note).
 */
export function CarIssueSheet({ car, issue, onClose, canManage, canReword }: Props) {
  const mutation = useUpdateCarIssueMutation();
  const [editing, setEditing] = useState<string | null>(null);
  const [maintenanceFor, setMaintenanceFor] = useState<string | null>(null);

  async function resolve() {
    if (!issue) return;
    try {
      await mutation.mutateAsync({ issueId: issue.id, action: "resolve" });
      toast.success(he.carPage.issueResolvedToast);
      onClose();
    } catch (error) {
      showErrorToast(error);
    }
  }

  async function saveWording() {
    if (!issue || editing === null || !editing.trim()) return;
    try {
      await mutation.mutateAsync({ issueId: issue.id, action: "edit", description: editing.trim() });
      toast.success(he.carPage.issueEditedToast);
      setEditing(null);
      onClose();
    } catch (error) {
      showErrorToast(error);
    }
  }

  return (
    <>
      <Dialog open={!!issue && editing === null} onOpenChange={(open) => { if (!open) onClose(); }}>
        <PortalDialogContent className="max-w-sm" data-testid="car-issue-sheet">
          <DialogHeader>
            <DialogTitle className="whitespace-pre-wrap break-words text-start text-base leading-snug">{issue?.description}</DialogTitle>
          </DialogHeader>
          {issue ? (
            <p className="text-xs text-muted-foreground">
              {issue.isUnsafe ? <span className="me-1.5 font-bold text-destructive">{he.adminIssues.unsafe}</span> : null}
              {formatDayDate(issue.createdAt)}
            </p>
          ) : null}
          <div className="flex flex-col gap-2 pt-1">
            {canManage ? (
              <Button className="justify-start gap-2" disabled={mutation.isPending} onClick={() => void resolve()} data-testid="car-issue-resolve">
                <Check className="size-4" aria-hidden="true" />
                {he.carPage.issueResolve}
              </Button>
            ) : null}
            {canManage || canReword ? (
              <Button variant="outline" className="justify-start gap-2" onClick={() => setEditing(issue?.description ?? "")} data-testid="car-issue-edit">
                <Pencil className="size-4" aria-hidden="true" />
                {he.carPage.issueEdit}
              </Button>
            ) : null}
            {canManage ? (
              <Button
                variant="outline"
                className="justify-start gap-2"
                onClick={() => { setMaintenanceFor(issue?.description ?? ""); onClose(); }}
                data-testid="car-issue-maintenance"
              >
                <CalendarClock className="size-4" aria-hidden="true" />
                {he.carPage.issueMaintenance}
              </Button>
            ) : null}
          </div>
        </PortalDialogContent>
      </Dialog>

      <FormDialog
        open={!!issue && editing !== null}
        onOpenChange={(open) => { if (!open) setEditing(null); }}
        title={he.carPage.issueEdit}
        submitLabel={he.carPage.saveField}
        loading={mutation.isPending}
        submitDisabled={!editing?.trim()}
        onSubmit={() => void saveWording()}
      >
        <Textarea autoFocus rows={3} value={editing ?? ""} onChange={(e) => setEditing(e.target.value)} data-testid="car-issue-edit-input" />
      </FormDialog>

      <MaintenancePeriodDialog
        target={maintenanceFor !== null ? { mode: "create", carId: car.id, carName: car.name, reason: maintenanceFor } : null}
        onOpenChange={(open) => { if (!open) setMaintenanceFor(null); }}
      />
    </>
  );
}
