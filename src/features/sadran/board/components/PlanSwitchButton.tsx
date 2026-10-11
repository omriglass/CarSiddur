// REQ §13.126 (h): the Sadran switches a request between plan A (the original trip) and plan B
// (`switch_request_plan`). Shown only for a request that has a plan B, is not a multi-day series
// and is not the pickup sibling a plan B created. Published day: the member is notified.
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { he, tv } from "@/i18n/he";
import { dateKey } from "@/lib/time";

import { alternativePlanText } from "../planBLine";
import type { RequestAlternativeEmbed } from "../../api";
import { useSwitchRequestPlanMutation, useWeekRow } from "../../hooks";

export interface PlanSwitchRequest {
  id: string;
  version: number | null | undefined;
  fallback?: string | null;
  alternative?: RequestAlternativeEmbed | null;
  served_by_alternative?: boolean | null;
  series_id?: string | null;
  plan_b_parent_id?: string | null;
  depart_at?: string | null;
  return_at?: string | null;
}

/** Does the request have a plan B the Sadran may switch to/from? */
function canSwitchPlan(request: PlanSwitchRequest): boolean {
  return request.fallback === "alternative" && !!request.alternative && !request.series_id && !request.plan_b_parent_id && request.version != null;
}

const PUBLIC_PHASES: ReadonlySet<string> = new Set(["published", "live", "archived"]);

export interface PlanSwitchButtonProps {
  request: PlanSwitchRequest;
  name: string;
  departmentId: string;
  weekStart: string;
  disabled?: boolean;
}

export function PlanSwitchButton({ request, name, departmentId, weekStart, disabled }: PlanSwitchButtonProps) {
  const [open, setOpen] = useState(false);
  const mutation = useSwitchRequestPlanMutation();
  const weekRow = useWeekRow(departmentId, weekStart).data;
  if (!canSwitchPlan(request) || !request.alternative) return null;
  const expectedVersion = request.version as number;
  const toAlternative = !request.served_by_alternative;
  const day = request.depart_at ?? request.return_at ?? null;
  // Same rule as SQL `is_day_public`: a public week phase AND the request's day among the published days.
  const published = !!weekRow && PUBLIC_PHASES.has(weekRow.phase) && !!day && (weekRow.published_days ?? []).includes(dateKey(day));
  const plan = alternativePlanText(request.alternative);
  const body = `${toAlternative ? tv("planSwitch.toAlternativeBody", { plan }) : he.planSwitch.toMainBody} ${published ? tv("planSwitch.notified", { name }) : he.planSwitch.silent}`;

  function confirm() {
    mutation.mutate({ requestId: request.id, to: toAlternative ? "alternative" : "main", expectedVersion, departmentId, weekStart }, {
      onSuccess: (result) => {
        setOpen(false);
        if (!toAlternative) toast.success(tv("planSwitch.backToMain", { name }));
        else if (result.rideId) toast.success(tv("planSwitch.placed", { name }));
        else toast.success(tv(published ? "planSwitch.waitlisted" : "planSwitch.unplaced", { name }));
      },
    });
  }

  return (
    <>
      <Button type="button" size="sm" variant="outline" className="min-h-11" disabled={disabled || mutation.isPending} onClick={() => setOpen(true)} data-testid="plan-switch" data-plan-request-id={request.id}>
        {toAlternative ? he.planSwitch.toAlternative : he.planSwitch.toMain}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={tv(toAlternative ? "planSwitch.toAlternativeTitle" : "planSwitch.toMainTitle", { name })}
        description={body}
        confirmLabel={he.planSwitch.confirm}
        loading={mutation.isPending}
        onConfirm={confirm}
      />
    </>
  );
}
