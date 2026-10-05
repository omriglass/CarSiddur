// REQ §13.95 (H3): "סוג נסיעה" selector - the Sadran changes a served/unmet request's trip type
// directly (`set_request_trip_type`; no draft, no proposal). The toast says whether the request
// stayed on its car or went back to the unmet list. Errors go through `showErrorToast`.
import { toast } from "sonner";

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
}

export function TripTypeChange({ requestId, version, tripType, name, departmentId, weekStart, disabled }: TripTypeChangeProps) {
  const mutation = useSetRequestTripTypeMutation();
  if (version == null || !tripType) return null;
  function change(next: string) {
    if (next === tripType || version == null) return;
    const chosen = TRIP_TYPES.find((type) => type === next);
    if (!chosen) return;
    mutation.mutate(
      { requestId, tripType: chosen, expectedVersion: version, departmentId, weekStart },
      {
        onSuccess: (result) => {
          if (!result.changed) return;
          const base = tv(result.rideId ? "tripTypeChange.stayed" : "tripTypeChange.unplaced", { name });
          toast.success(result.restoredReturnAt
            ? `${base} · ${tv("tripTypeChange.returnRestored", { time: formatTime(new Date(result.restoredReturnAt)) })}`
            : base);
        },
      },
    );
  }
  return (
    <div className="flex items-center gap-2" data-testid="trip-type-change" data-trip-request-id={requestId}>
      <span className="shrink-0 text-xs text-muted-foreground">{he.tripTypeChange.label}</span>
      <Select value={tripType} onValueChange={change} disabled={disabled || mutation.isPending}>
        <SelectTrigger className="min-h-11 flex-1" aria-label={tv("tripTypeChange.aria", { name })} data-testid="trip-type-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TRIP_TYPES.map((type) => (
            <SelectItem key={type} value={type} data-testid={`trip-type-option-${type}`}>{TRIP_TYPE_LABEL[type]}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
