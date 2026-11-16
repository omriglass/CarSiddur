// REQ item 246 h (owner mock board 5): tap a name in the people summary - the dialog opens on how they ride now (the
// simplest choice that describes it), with "שמירה" and "הסרה מהנסיעה". The seat line leaves the edited person out.
import { useState } from "react";
import { toast } from "sonner";

import { FormDialog } from "@/components/FormDialog";
import { Button } from "@/components/ui/button";
import { he } from "@/i18n/he";
import type { RouteLeg, RoutePoint } from "@/lib/rideRoute";

import { useRemoveRidePassengerMutation, useSetRidePersonPartMutation } from "../hooks";
import { partsPayload, roomFor, type PersonParts, type RideStretches } from "../rideStretches";
import type { RidePerson } from "../ridePeople";
import { RidePartsPicker } from "./RidePartsPicker";

export interface RidePersonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  person: RidePerson;
  rideId: string;
  expectedVersion: number;
  departmentId: string;
  weekStart: string;
  points: readonly RoutePoint[];
  legs: readonly RouteLeg[];
  initial: PersonParts;
  stretches: RideStretches | undefined;
  middle: boolean;
  allowedPositions?: Partial<Record<RouteLeg, readonly number[]>>;
  /** A person whose places do not count (a merged guest request's people): riding a way = all of it. */
  wholeLegsOnly: boolean;
  canRemove: boolean;
}

function sameParts(a: PersonParts, b: PersonParts): boolean {
  return JSON.stringify([a.out, a.return]) === JSON.stringify([b.out, b.return]);
}

export function RidePersonDialog({ open, onOpenChange, person, rideId, expectedVersion, departmentId, weekStart, points, legs, initial, stretches, middle, allowedPositions, wholeLegsOnly, canRemove }: RidePersonDialogProps) {
  const [parts, setParts] = useState<PersonParts>(initial);
  const save = useSetRidePersonPartMutation();
  const remove = useRemoveRidePassengerMutation();
  const busy = save.isPending || remove.isPending;
  const room = stretches ? roomFor(parts, stretches, person.seat_kind === "adult" ? 1 : 0, initial) : null;
  const riding = !!parts.out || !!parts.return;

  function submit() {
    if (sameParts(parts, initial)) { onOpenChange(false); return; }
    const payload = wholeLegsOnly
      ? Object.fromEntries(legs.map((leg) => [leg, parts[leg] ? {} : null]))
      : partsPayload(parts, points);
    save.mutate(
      { rideId, expectedVersion, personKey: person.key, parts: payload, departmentId, weekStart },
      { onSuccess: () => { toast.success(he.addPassengers.saved); onOpenChange(false); } },
    );
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => { if (!busy) onOpenChange(next); }}
      title={person.display_name}
      onSubmit={submit}
      submitLabel={he.addPassengers.save}
      cancelLabel={he.addPassengers.back}
      loading={save.isPending}
      submitDisabled={!riding || room === false || remove.isPending}
    >
      <div className="space-y-4" data-testid="ride-person-dialog">
        {legs.length ? (
          <RidePartsPicker points={points} legs={legs} value={parts} onChange={setParts} middle={middle} room={room}
            allowedPositions={allowedPositions} />
        ) : null}
        {canRemove ? (
          <Button type="button" variant="outline" className="w-full text-destructive" disabled={busy} data-testid="ride-person-remove"
            onClick={() => remove.mutate(
              { rideId, expectedVersion, key: person.key, departmentId, weekStart },
              { onSuccess: () => { toast.success(he.addPassengers.removed); onOpenChange(false); } },
            )}>
            {he.addPassengers.removeFromRide}
          </Button>
        ) : null}
      </div>
    </FormDialog>
  );
}
