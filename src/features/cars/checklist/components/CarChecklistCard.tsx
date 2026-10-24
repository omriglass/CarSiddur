import { ClipboardCheck } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { paths } from "@/app/routes";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";

import { useCarChecklistStatusQuery, useMyChecklistPromptsQuery } from "../hooks";
import { normalizeFailures } from "../lib/answers";

import { ChecklistFormDialog } from "./ChecklistFormDialog";

interface Props {
  car: { id: string; name: string; department_id: string };
  /** `can_manage_car`: may complete the checklist any time. */
  canManageCar: boolean;
  /** Admin or a car admin of the department: may edit the department's items. */
  canDefine: boolean;
}

/**
 * The car's checklist on `/cars/:carId` (REQ item 150 d): "תקין ב־<date>" or "לא תקין ב־<date>" with what failed —
 * it records what was true that day and never goes stale — plus the "בדיקת רכב" button and, for a new responsible
 * person, the prompt that stays until they complete one.
 */
export function CarChecklistCard({ car, canManageCar, canDefine }: Props) {
  const statusQuery = useCarChecklistStatusQuery(car.id);
  const promptsQuery = useMyChecklistPromptsQuery();
  const [open, setOpen] = useState(false);
  const status = statusQuery.data ?? null;
  const prompted = (promptsQuery.data ?? []).some((prompt) => prompt.car_id === car.id);
  const failures = status ? normalizeFailures(status.failures) : [];
  if (!canManageCar && !status) return null;

  return (
    <>
      <Card className="bg-gradient-card shadow-card" data-testid="car-checklist-card">
        <CardContent className="space-y-2 p-3 text-sm">
          {prompted ? (
            <p className="rounded-md bg-primary/10 p-2 font-medium text-primary" data-testid="checklist-prompt">
              {he.carChecklist.promptBanner}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <ClipboardCheck className="size-5" aria-hidden="true" />
              </span>
              <div>
                <p className="text-xs text-muted-foreground">{he.carChecklist.cardTitle}</p>
                <p className={status ? (status.green ? "font-medium text-available" : "font-medium text-destructive") : "font-medium"} data-testid="checklist-status">
                  {status
                    ? tv(status.green ? "carChecklist.green" : "carChecklist.notGreen", { date: formatDayDate(status.completed_at) })
                    : he.carChecklist.none}
                </p>
                {status?.completed_by_name ? (
                  <p className="text-xs text-muted-foreground">{tv("carChecklist.checkedBy", { name: status.completed_by_name })}</p>
                ) : null}
              </div>
            </div>
            {canManageCar ? (
              <Button variant={prompted ? "default" : "outline"} size="sm" onClick={() => setOpen(true)} data-testid="checklist-open">
                {prompted ? he.carChecklist.promptStart : he.carChecklist.button}
              </Button>
            ) : null}
          </div>
          {failures.length > 0 ? (
            <div data-testid="checklist-failures">
              <p className="text-xs font-medium text-muted-foreground">{he.carChecklist.failedHeading}</p>
              <ul className="list-disc ps-5">
                {failures.map((failure) => (
                  <li key={`${failure.item_id}:${failure.label}`}>
                    {tv(failure.reason === "expired" ? "carChecklist.reasonExpired" : "carChecklist.reasonNo", { label: failure.label })}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {canDefine ? (
            <Link className="text-xs text-primary underline" to={paths.carChecklist(car.department_id)} data-testid="checklist-edit-link">
              {he.carChecklist.editList}
            </Link>
          ) : null}
        </CardContent>
      </Card>
      {canManageCar ? <ChecklistFormDialog car={car} open={open} onOpenChange={setOpen} /> : null}
    </>
  );
}
