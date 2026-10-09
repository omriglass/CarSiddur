// REQ §13.95 (H3): "סוג נסיעה" selector - the Sadran changes a served/unmet request's trip type
// directly (`set_request_trip_type`; no draft, no proposal). The toast says whether the request
// stayed on its car or went back to the unmet list. Errors go through `showErrorToast`.
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { he, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";
import { TRIP_TYPES, type TripType } from "@/lib/enums";

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
  name: string;
  departmentId: string;
  weekStart: string;
  disabled?: boolean;
  /** R8B12: the request had no car (unmet card), so a placed result reads "placed", not "stayed on its car". */
  wasUnplaced?: boolean;
}

export function TripTypeChange({ requestId, version, tripType, name, departmentId, weekStart, disabled, wasUnplaced }: TripTypeChangeProps) {
  const mutation = useSetRequestTripTypeMutation();
  // R2U2: choosing a type asks first; the select then shows the chosen type until the refetched row agrees.
  const [pending, setPending] = useState<TripType | null>(null);
  const [applied, setApplied] = useState<TripType | null>(null);
  if (version == null || !tripType) return null;
  function change(next: string) {
    if (next === tripType || version == null) return;
    const chosen = TRIP_TYPES.find((type) => type === next);
    if (chosen) setPending(chosen);
  }
  function apply(chosen: TripType) {
    if (version == null) return;
    setPending(null);
    mutation.mutate(
      { requestId, tripType: chosen, expectedVersion: version, departmentId, weekStart },
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
  return (
    <div className="flex items-center gap-2" data-testid="trip-type-change" data-trip-request-id={requestId}>
      <span className="shrink-0 text-xs text-muted-foreground">{he.tripTypeChange.label}</span>
      <Select value={applied && applied !== tripType && mutation.isSuccess ? applied : tripType} onValueChange={change} disabled={disabled || mutation.isPending}>
        <SelectTrigger className="min-h-11 flex-1" aria-label={tv("tripTypeChange.aria", { name })} data-testid="trip-type-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TRIP_TYPES.map((type) => (
            <SelectItem key={type} value={type} data-testid={`trip-type-option-${type}`}>{TRIP_TYPE_LABEL[type]}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ConfirmDialog
        open={!!pending}
        onOpenChange={(open) => { if (!open) setPending(null); }}
        title={tv("tripTypeChange.confirmTitle", { name })}
        description={pending ? tv("tripTypeChange.confirmBody", { name, type: TRIP_TYPE_LABEL[pending] }) : undefined}
        confirmLabel={he.tripTypeChange.confirm}
        onConfirm={() => { if (pending) apply(pending); }}
      />
    </div>
  );
}
