// REQ §13.129: the ride sheet's two driver-side actions — "move to my car" (private car owner, a) and "remove me, <name> drives"
// (the driver, b). One hook so the siddur and Home spread the same props into `RideDetailSheet`.
import { useDepartmentMembers } from "@/features/auth/useDepartmentMembers";
import type { Week } from "@/features/siddur/api";

import type { BoardRide } from "./api";
import { handOverCandidates } from "./handOver";
import { useHandOverOwnRideMutation } from "./hooks";
import { ownCarMoveTargets, rideDayPublished } from "./ownCarMove";
import { useOwnCarMove } from "./useOwnCarMove";

export interface RideSheetCarActionsOptions {
  departmentId: string | undefined;
  profileId: string | undefined;
  myRequestIds: ReadonlySet<string>;
  /** The ride's own week row (phase, published days). */
  week: Pick<Week, "phase" | "published_days"> | null | undefined;
  /** The viewer is a member of the ride's department. */
  isMember: boolean;
  now: Date;
}

export function useRideSheetCarActions({ departmentId, profileId, myRequestIds, week, isMember, now }: RideSheetCarActionsOptions) {
  const { myCars, moveRideToCar, moving } = useOwnCarMove(profileId);
  const membersQuery = useDepartmentMembers(departmentId);
  const handOver = useHandOverOwnRideMutation();

  /** Props for `RideDetailSheet`; empty when the ride is null or no action applies. */
  function sheetProps(ride: BoardRide | null, onDone: () => void) {
    if (!ride?.id || ride.version == null || !isMember) return {};
    const targetIds = ownCarMoveTargets({ ride, myCarIds: myCars.map((car) => car.id), dayPublished: rideDayPublished(week, ride.starts_at), now });
    const candidates = handOverCandidates(ride, profileId, myRequestIds, membersQuery.data ?? []);
    const { id, version, department_id, week_start } = ride;
    return {
      moveToCarOptions: myCars.filter((car) => targetIds.includes(car.id)),
      onMoveToCar: (carId: string) => void moveRideToCar(ride, carId, onDone),
      movingToCar: moving,
      handOverOptions: candidates,
      onHandOver: department_id && week_start
        ? (newDriver: string) => handOver.mutate({ rideId: id, expectedVersion: version, newDriver, departmentId: department_id, weekStart: week_start }, { onSuccess: onDone })
        : undefined,
      handingOver: handOver.isPending,
    };
  }

  return { sheetProps };
}
