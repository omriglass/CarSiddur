// REQ §13.129 (a): the owner of an active private car moves a ride onto it (the ride sheet button and the grid drag share this).
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useMyTemporaryCars } from "@/features/fleet/hooks";
import { useEditRideMutation } from "@/features/sadran/hooks";
import { siddurKeys } from "@/features/siddur/queryKeys";
import { he } from "@/i18n/he";

import type { BoardRide } from "./api";

export interface OwnCar {
  id: string;
  name: string;
}

export function useOwnCarMove(profileId: string | undefined) {
  const queryClient = useQueryClient();
  const carsQuery = useMyTemporaryCars(profileId);
  const editMutation = useEditRideMutation();
  const myCars: OwnCar[] = (carsQuery.data ?? []).filter((car) => car.status === "active" && !car.retired_at).map((car) => ({ id: car.id, name: car.name }));

  /** The member `edit_ride` path with the ride's own times and driver; only the car changes. Errors toast via the mutation. */
  async function moveRideToCar(ride: BoardRide, carId: string, onDone?: () => void): Promise<void> {
    if (!ride.id || ride.version == null || !ride.starts_at || !ride.ends_at || !ride.origin_id || !ride.destination_id || !ride.department_id || !ride.week_start) return;
    try {
      await editMutation.mutateAsync({
        input: { id: ride.id, department_id: ride.department_id, week_start: ride.week_start, car_id: carId, starts_at: ride.starts_at,
          ends_at: ride.ends_at, origin_id: ride.origin_id, destination_id: ride.destination_id, driver_id: ride.driver_id },
        expectedVersion: ride.version, departmentId: ride.department_id, weekStart: ride.week_start,
      });
      await queryClient.invalidateQueries({ queryKey: siddurKeys.boardRides(ride.department_id, ride.week_start) });
      await queryClient.invalidateQueries({ queryKey: siddurKeys.carLocations(ride.department_id, ride.week_start) });
      onDone?.();
      toast.success(he.rideEditing.saved);
    } catch { /* The mutation displays the database validation error. */ }
  }

  return { myCars, moveRideToCar, moving: editMutation.isPending };
}
