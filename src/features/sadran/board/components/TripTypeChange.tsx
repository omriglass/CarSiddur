// REQ §13.95 (H3): "סוג נסיעה" selector - the Sadran changes a served/unmet request's trip type
// directly (`set_request_trip_type`; no draft, no proposal). The toast says whether the request
// stayed on its car or went back to the unmet list. Errors go through `showErrorToast`.
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { keepCarTripLabel } from "@/features/requests/keepCar";
import { he, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";
import type { TripType } from "@/lib/enums";

import { useSetRequestTripTypeMutation } from "../../hooks";

const TRIP_TYPE_LABEL: Record<TripType, string> = {
  round_trip: he.request.tripTypeRoundTrip,
  one_way: he.request.tripTypeOneWay,
  drop_off: he.request.tripTypeDropOff,
};

export interface TripTypeChangeProps {
  requestId: string;
  /** The request's `version` (optimistic concurrency); the control is hidden without it. */
  version: number | null | undefined;
  tripType: TripType | null | undefined;
  /** REQ §13.126 (g): a stored drop_off with this flag reads "הלוך-חזור · הרכב נשאר ב…" (never "הקפצה"). */
  keepCarAtDestination?: boolean | null;
  destination?: string | null;
  name: string;
  departmentId: string;
  weekStart: string;
  disabled?: boolean;
  /** R8B12: the request had no car (unmet card), so a placed result reads "placed", not "stayed on its car". */
  wasUnplaced?: boolean;
  /** Controlled mode (the unmet card's "⋮" menu opens it): no inline trigger button is rendered. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** The menu's choices: the three trip types plus "round trip, the car stays at the destination" (REQ §13.126 g). */
type TripChoice = TripType | "keep_car";
const KEEP_CAR = "keep_car" as const;
const CHOICES: TripChoice[] = ["round_trip", KEEP_CAR, "one_way", "drop_off"];

export function TripTypeChange({ requestId, version, tripType, keepCarAtDestination, destination, name, departmentId, weekStart, disabled, wasUnplaced, open: menuOpen, onOpenChange: onMenuOpenChange }: TripTypeChangeProps) {
  const mutation = useSetRequestTripTypeMutation();
  // R2U2: choosing a type asks first; the select then shows the chosen type until the refetched row agrees.
  const [pending, setPending] = useState<TripChoice | null>(null);
  const [applied, setApplied] = useState<TripChoice | null>(null);
  if (version == null || !tripType) return null;
  const current: TripChoice = tripType === "drop_off" && keepCarAtDestination ? KEEP_CAR : tripType;
  const labelOf = (choice: TripChoice): string => (choice === KEEP_CAR ? keepCarTripLabel(destination) : TRIP_TYPE_LABEL[choice]);
  function change(next: string) {
    if (next === current || version == null) return;
    const chosen = CHOICES.find((choice) => choice === next);
    if (chosen) setPending(chosen);
  }
  function apply(chosen: TripChoice) {
    if (version == null) return;
    setPending(null);
    mutation.mutate(
      { requestId, tripType: chosen === KEEP_CAR ? "drop_off" : chosen, keepCar: chosen === KEEP_CAR, expectedVersion: version, departmentId, weekStart },
      {
        onSuccess: (result) => {
          setApplied(chosen);
          if (!result.changed) return;
          const base = tv(result.rideId ? (wasUnplaced ? "tripTypeChange.placed" : "tripTypeChange.stayed") : "tripTypeChange.unplaced", { name });
          const detail = result.restoredReturnAt
            ? tv("tripTypeChange.returnRestored", { time: formatTime(new Date(result.restoredReturnAt)) })
            : result.defaultedReturnAt
              ? tv("tripTypeChange.returnDefaulted", { time: formatTime(new Date(result.defaultedReturnAt)) })
              : "";
          toast.success(detail ? `${base} · ${detail}` : base);
        },
      },
    );
  }
  const controlled = onMenuOpenChange !== undefined;
  const shown: TripChoice = applied && applied !== current && mutation.isSuccess ? applied : current;
  const confirmDialog = (
    <ConfirmDialog
      open={!!pending}
      onOpenChange={(open) => { if (!open) setPending(null); }}
      title={tv("tripTypeChange.confirmTitle", { name })}
      description={pending ? tv("tripTypeChange.confirmBody", { name, type: labelOf(pending) }) : undefined}
      confirmLabel={he.tripTypeChange.confirm}
      onConfirm={() => { if (pending) apply(pending); }}
    />
  );
  // Menu mode (the unmet card's "⋮"): a picker dialog, then the same confirmation.
  if (controlled) {
    return (
      <>
        <ConfirmDialog
          open={!!menuOpen}
          onOpenChange={onMenuOpenChange}
          title={tv("unmetCard.changeTripTypeTitle", { name })}
          hideConfirm
          onConfirm={() => undefined}
        >
          <div className="flex flex-col gap-2" data-testid="trip-type-change" data-trip-request-id={requestId}>
            {CHOICES.map((choice) => (
              <Button key={choice} type="button" variant={choice === current ? "secondary" : "outline"} className="min-h-11 justify-start" disabled={disabled || mutation.isPending || choice === current}
                data-testid={`trip-type-option-${choice}`} onClick={() => { onMenuOpenChange(false); change(choice); }}>
                {labelOf(choice)}
              </Button>
            ))}
          </div>
        </ConfirmDialog>
        {confirmDialog}
      </>
    );
  }
  return (
    <div className="flex items-center gap-2" data-testid="trip-type-change" data-trip-request-id={requestId}>
      <span className="shrink-0 text-xs text-muted-foreground">{he.tripTypeChange.label}</span>
      <Select value={shown} onValueChange={change} disabled={disabled || mutation.isPending}>
        <SelectTrigger className="min-h-11 flex-1" aria-label={tv("tripTypeChange.aria", { name })} data-testid="trip-type-select">
          <SelectValue>{labelOf(shown)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {CHOICES.map((choice) => (
            <SelectItem key={choice} value={choice} data-testid={`trip-type-option-${choice}`}>
              {labelOf(choice)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {confirmDialog}
    </div>
  );
}
