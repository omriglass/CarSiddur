// REQ item 136 (e), owner 2026-10-17: the guided checklist for a displacement suggestion (UX_FLOWS §4.2). A non-modal
// panel over the bottom of the board (the involved rides stay highlighted and clickable behind it). Every button only
// calls an action the board already has; done state is re-derived from the live rides after each one.
import { useState } from "react";
import { Check, Circle, X } from "lucide-react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { dateKey, formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";

import { slotToIso } from "../geometry";
import type { ChecklistStep } from "../displacementChecklist";

export interface DisplacementChecklistProps {
  steps: readonly ChecklistStep[];
  weekStartMs: number | null;
  selectedDay: string;
  carName: (carId: string) => string;
  requesterName: (requestId: string) => string;
  /** The target is a whole multi-day trip (series head). */
  series: boolean;
  busy: boolean;
  onGoToDay: (day: string) => void;
  onUnplace: (rideId: string) => void | Promise<void>;
  onMove: (step: Extract<ChecklistStep, { kind: "move" }>) => void | Promise<void>;
  onPlace: (step: Extract<ChecklistStep, { kind: "place" }>) => void | Promise<void>;
  onShow: (rideId: string) => void;
  onClose: () => void;
}

export function DisplacementChecklist({ steps, weekStartMs, selectedDay, carName, requesterName, series, busy, onGoToDay, onUnplace, onMove, onPlace, onShow, onClose }: DisplacementChecklistProps) {
  const [confirmUnplace, setConfirmUnplace] = useState<Extract<ChecklistStep, { kind: "unplace" }> | null>(null);
  const target = steps.find((step) => step.kind === "place");
  const allDone = steps.every((step) => step.done);

  function when(step: ChecklistStep): { iso: string | null; text: string } {
    if (weekStartMs == null) return { iso: null, text: "" };
    const iso = slotToIso(step.window.start, weekStartMs);
    return { iso, text: `${formatDayDate(iso)} ` };
  }

  function label(step: ChecklistStep): string {
    const name = requesterName(step.requestId);
    if (step.kind === "unplace") return tv("displacement.stepUnplace", { name, car: carName(step.fromCarId) });
    if (step.kind === "move") return tv("displacement.stepMove", { name, from: carName(step.fromCarId), to: carName(step.toCarId) });
    return tv(series ? "displacement.stepPlaceSeries" : "displacement.stepPlace", { name, car: carName(step.carId) });
  }

  return (
    <section
      className="fixed inset-x-2 bottom-2 z-40 mx-auto max-h-[55dvh] max-w-xl space-y-2 overflow-auto rounded-lg border bg-card p-3 shadow-lg"
      aria-label={he.displacement.title}
      data-testid="displacement-checklist"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-semibold">{he.displacement.title}</h2>
        <Button type="button" variant="ghost" size="icon" className="size-11 shrink-0" onClick={onClose} aria-label={he.displacement.closeAria} data-testid="displacement-close">
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>
      {target ? <p className="text-sm text-muted-foreground">{tv("displacement.intro", { name: requesterName(target.requestId), car: carName(target.kind === "place" ? target.carId : "") })}</p> : null}
      <ol className="space-y-2">
        {steps.map((step, index) => {
          const w = when(step);
          const otherDay = w.iso != null && dateKey(w.iso) !== selectedDay;
          const rideId = step.rideIds[0];
          return (
            <li key={step.key} className={cn("flex items-center justify-between gap-2 rounded-md border p-2 text-sm", step.done && "bg-muted/50 text-muted-foreground")} data-testid={`displacement-step-${step.kind}`} data-done={step.done ? "true" : "false"}>
              <span className="flex min-w-0 items-start gap-2">
                {step.done ? <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden="true" /> : <Circle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
                <span className="min-w-0">
                  <span className="sr-only">{step.done ? he.displacement.done : he.displacement.notDone}: </span>
                  {`${index + 1}. ${label(step)} · ${w.text}`}
                  {w.iso ? <span dir="ltr">{formatTime(new Date(w.iso))}</span> : null}
                </span>
              </span>
              {step.done ? null : (
                <span className="flex shrink-0 gap-1">
                  {step.kind !== "place" && rideId ? <Button type="button" size="sm" variant="ghost" className="min-h-11" onClick={() => onShow(rideId)} disabled={busy}>{he.displacement.showMe}</Button> : null}
                  {otherDay && w.iso ? (
                    <Button type="button" size="sm" variant="outline" className="min-h-11" onClick={() => onGoToDay(dateKey(w.iso as string))}>{he.displacement.goToDay}</Button>
                  ) : (
                    <Button
                      type="button" size="sm" variant="outline" className="min-h-11" disabled={busy || weekStartMs == null || (step.kind !== "place" && !rideId)}
                      onClick={() => { if (step.kind === "unplace") setConfirmUnplace(step); else if (step.kind === "move") void onMove(step); else void onPlace(step); }}
                    >
                      {step.kind === "unplace" ? he.displacement.doUnplace : step.kind === "move" ? he.displacement.doMove : he.displacement.doPlace}
                    </Button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {allDone ? <p className="text-sm font-medium" role="status">{he.displacement.allDone}</p> : null}
      <ConfirmDialog
        open={!!confirmUnplace}
        onOpenChange={(open) => { if (!open) setConfirmUnplace(null); }}
        title={tv("displacement.unplaceTitle", { name: confirmUnplace ? requesterName(confirmUnplace.requestId) : "", car: confirmUnplace ? carName(confirmUnplace.fromCarId) : "" })}
        description={he.displacement.unplaceBody}
        confirmLabel={he.displacement.unplaceConfirm}
        destructive
        loading={busy}
        onConfirm={() => {
          const step = confirmUnplace;
          setConfirmUnplace(null);
          const rideId = step?.rideIds[0];
          if (rideId) void onUnplace(rideId);
        }}
      />
    </section>
  );
}
