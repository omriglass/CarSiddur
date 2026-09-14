import { X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { he, tv } from "@/i18n/he";

import { canRemoveRidePerson, type RidePerson } from "../ridePeople";
import { useRemoveRidePassengerMutation } from "../hooks";

interface RidePassengersListProps {
  rideId: string | null;
  expectedVersion: number | null;
  people: readonly RidePerson[];
  /** Same authorization gate `add_ride_passengers()`/`remove_ride_person()` use — any department
   * member once the ride's week is public, or a Sadran/admin who manages it. Callers already
   * compute this to decide whether to show the "+ נוסעים" button (`showAddPassengers`), so it is
   * reused here rather than recomputed. */
  canManagePeople?: boolean;
  rideCancelled?: boolean;
}

/**
 * ONE list of everyone on the ride (owner decision 2026-09-14: "people added directly are
 * indistinguishable at a glance from request-filed ones") — driver first (marked, never
 * removable), then every served request's requester/companions/children/guests and every
 * directly `add_ride_passengers()`-added row, all read from the unified
 * `v_board_rides.people` (`../ridePeople.ts`). Replaces the previous `source: 'added'`-only
 * list this component used to render.
 */
export function RidePassengersList({ rideId, expectedVersion, people, canManagePeople = false, rideCancelled = false }: RidePassengersListProps) {
  const mutation = useRemoveRidePassengerMutation();
  if (!people.length) return null;

  return (
    <div className="space-y-1">
      <span className="font-medium">{he.rideDetail.passengers}</span>
      <ul className="space-y-0.5">
        {people.map((person) => {
          const removable = rideId != null && expectedVersion != null &&
            canRemoveRidePerson(person, { canManagePeople, rideCancelled });
          return (
            <li key={person.key} className="flex items-center justify-between gap-2">
              <span>
                {person.display_name}
                {person.source === "driver" ? ` · ${he.ride.driver}` : ""}
              </span>
              {removable ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6 shrink-0"
                  aria-label={tv("addPassengers.removeAriaLabel", { name: person.display_name })}
                  disabled={mutation.isPending}
                  onClick={() => {
                    if (rideId == null || expectedVersion == null) return;
                    mutation.mutate(
                      { rideId, expectedVersion, key: person.key },
                      { onSuccess: () => toast.success(he.addPassengers.removed) },
                    );
                  }}
                >
                  <X className="size-3.5" />
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
