import { X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useSession } from "@/features/auth/useSession";
import { he, tv } from "@/i18n/he";

import { canRemoveRidePassenger } from "../addPassengers";
import { useRemoveRidePassengerMutation } from "../hooks";

import type { RidePassengerEntry } from "@/features/sadran/applySolve";

interface RidePassengersListProps {
  expectedVersion: number | null;
  passengers: readonly RidePassengerEntry[];
  driverId?: string | null;
  canManageWeek?: boolean;
}

/**
 * Named `ride_passengers` rows (F3, 20260914120000_ride_passengers.sql; "+ נוסעים",
 * 20260914170000_add_ride_passengers_rpc.sql, REQ §13.85) — distinct from `served`
 * (request-backed passengers, already shown above this in both sheets). Each row gets a
 * remove (×) only when `remove_ride_passenger()` would actually allow the current user to
 * (the adder, the named person, the driver, or a week manager) — the RPC re-checks this
 * server-side regardless, this is only about not showing an affordance that would 403.
 */
export function RidePassengersList({ expectedVersion, passengers, driverId, canManageWeek = false }: RidePassengersListProps) {
  const { session } = useSession();
  const currentUserId = session?.user.id;
  const mutation = useRemoveRidePassengerMutation();
  if (!passengers.length) return null;

  return (
    <div className="space-y-1">
      <span className="font-medium">{he.addPassengers.listTitle}</span>
      <ul className="space-y-0.5">
        {passengers.map((passenger) => {
          const removable = expectedVersion != null && canRemoveRidePassenger(passenger, currentUserId, driverId, canManageWeek);
          return (
            <li key={passenger.id} className="flex items-center justify-between gap-2">
              <span>{passenger.display_name}</span>
              {removable ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6 shrink-0"
                  aria-label={tv("addPassengers.removeAriaLabel", { name: passenger.display_name })}
                  disabled={mutation.isPending}
                  onClick={() => {
                    if (expectedVersion == null) return;
                    mutation.mutate(
                      { ridePassengerId: passenger.id, expectedVersion },
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
