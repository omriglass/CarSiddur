// A member moving / resizing their own ride on a grid — one implementation for the siddur table and the "my rides"
// week view (owner 2026-10-11: dragging must behave the same in both). REQ: members move their own future rides to a
// free slot on the same local day; a collision asks the other drivers instead (`request_ride_change`).
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { useCarSeatConfigs, useCars, useMaintenanceBlocks } from "@/features/fleet/hooks";
import { useDepartmentSettings, useEditRideMutation } from "@/features/sadran/hooks";
import type { Week } from "@/features/siddur/api";
import { useBoardRides } from "@/features/siddur/hooks";
import { siddurKeys } from "@/features/siddur/queryKeys";
import { conflictingRides, moveOnRideDay } from "@/features/siddur/rideEditing";
import { he, tv } from "@/i18n/he";
import { dateKey } from "@/lib/time";
import { effectiveWeekSettings } from "@/lib/weekSettings";

import type { RideMove } from "./api";
import { useRequestRideChangeMutation, useRideChanges } from "./hooks";
import { canMoveOntoMyCar, rideDayPublished } from "./ownCarMove";
import { isRideRelated } from "./relatedRide";
import { isRideDayEditable } from "./rideDayEditable";
import { servedOf } from "./servedOf";
import { useOwnCarMove } from "./useOwnCarMove";

export interface MemberRideMovesOptions {
  departmentId: string | undefined;
  weekStart: string | undefined;
  /** The shown week's row (phase, published days). */
  week: Pick<Week, "phase" | "published_days" | "settings_overrides"> | null | undefined;
  profileId: string | undefined;
  /** REQ §13.127 (b): ids of the requests the member requested or filed (`useMyRequests`) — a ride serving one is theirs to move. */
  myRequestIds?: ReadonlySet<string>;
  /** The viewer is a member of this department (only members edit their rides). */
  isMember: boolean;
  now: Date;
  /** After a move was saved or a collision request was sent (e.g. close the open ride sheet). */
  onDone?: () => void;
}

export function useMemberRideMoves({ departmentId, weekStart, week, profileId, myRequestIds, isMember, now, onDone }: MemberRideMovesOptions) {
  const queryClient = useQueryClient();
  const boardRidesQuery = useBoardRides(departmentId, weekStart);
  const changesQuery = useRideChanges(departmentId, weekStart, { scoped: true });
  const carsQuery = useCars(departmentId);
  const maintenanceQuery = useMaintenanceBlocks(departmentId);
  const seatsQuery = useCarSeatConfigs(departmentId);
  const settingsQuery = useDepartmentSettings(departmentId);
  const editMutation = useEditRideMutation();
  const changeMutation = useRequestRideChangeMutation();
  const [collisionMove, setCollisionMove] = useState<(RideMove & { departmentId: string; weekStart: string }) | null>(null);
  // REQ §13.129 (a): a drag of someone else's ride onto my private car waits for the owner's confirmation.
  const [ownCarMove, setOwnCarMove] = useState<RideMove | null>(null);
  const { myCars } = useOwnCarMove(profileId);

  const rides = boardRidesQuery.data ?? [];
  const pendingChanges = changesQuery.data ?? [];
  // REQ §13.108 D1: the shown week's override of the turnaround buffer wins over the department's.
  const turnaroundMinutes = effectiveWeekSettings(settingsQuery.data, week ?? null).turnaroundMinutes;
  const weekEditable = isMember && (week?.phase === "live" || week?.phase === "published");

  /**
   * A ride of today or a later day that is mine (REQ §13.127 b: I drive it, it serves a request I made or filed, I am a named passenger, or
   * it is on my private car) — keeping the car, or my own one-way (הלוך בלבד, owner 2026-10-11: a relay leg that leaves
   * the car at the destination; never a הקפצה relay leg) — on a published day, with no change request pending.
   * The server's `edit_ride` member branch is the same rule.
   */
  function ownsEditableRide(rideId: string): boolean {
    const ride = rides.find((r) => r.id === rideId);
    if (!ride?.starts_at || !weekEditable) return false;
    if (!(week?.published_days?.includes(dateKey(ride.starts_at)) ?? true)) return false;
    if (servedOf(ride).some((entry) => entry.role !== "driver"
      || !(entry.car_mode === "keep" || (entry.car_mode === "relay" && entry.trip_type === "one_way")))) return false;
    const car = carsQuery.data?.find((c) => c.id === ride.car_id);
    const related = isRideRelated({ ride, profileId, myRequestIds: myRequestIds ?? new Set(), carOwnerId: car?.type === "temporary" ? car.owner_id : null });
    return related && isRideDayEditable(ride.starts_at, now)
      && !pendingChanges.some((c) => c.ride_id === rideId);
  }

  /**
   * REQ §13.129 (a): a ride that is not mine to move, but I own an active private car it can go onto (published day, today or later,
   * no relay leg, no change request pending) — draggable, onto my own private cars only.
   */
  function movableOntoMyCar(rideId: string): boolean {
    const ride = rides.find((r) => r.id === rideId);
    if (!ride || !weekEditable || ownsEditableRide(rideId) || pendingChanges.some((c) => c.ride_id === rideId)) return false;
    return canMoveOntoMyCar({ ride, myCarIds: myCars.map((car) => car.id), dayPublished: rideDayPublished(week, ride.starts_at), now });
  }
  const canDragRide = (rideId: string) => ownsEditableRide(rideId) || movableOntoMyCar(rideId);

  async function saveMove(move: RideMove) {
    const ride = rides.find((r) => r.id === move.rideId);
    if (!ride || !departmentId || !weekStart || !ride.origin_id || !ride.destination_id) return;
    const foreign = !ownsEditableRide(move.rideId);
    if (foreign) {
      if (!movableOntoMyCar(move.rideId) || !myCars.some((car) => car.id === move.carId)) return;
      setOwnCarMove(move);
      return;
    }
    await persistMove(move);
  }

  async function persistMove(move: RideMove) {
    const ride = rides.find((r) => r.id === move.rideId);
    if (!ride || !departmentId || !weekStart || !ride.origin_id || !ride.destination_id) return;
    if (ownsEditableRide(move.rideId) && conflictingRides(move, rides, turnaroundMinutes).length) {
      setCollisionMove({ ...move, departmentId, weekStart });
      return;
    }
    try {
      await editMutation.mutateAsync({
        input: { id: move.rideId, department_id: departmentId, week_start: weekStart, car_id: move.carId,
          starts_at: move.startsAt, ends_at: move.endsAt, origin_id: ride.origin_id, destination_id: ride.destination_id,
          driver_id: ride.driver_id },
        expectedVersion: move.expectedVersion, departmentId, weekStart,
      });
      await queryClient.invalidateQueries({ queryKey: siddurKeys.boardRides(departmentId, weekStart) });
      await queryClient.invalidateQueries({ queryKey: siddurKeys.carLocations(departmentId, weekStart) });
      onDone?.();
      toast.success(he.rideEditing.saved);
    } catch { /* Mutation displays the database validation error. */ }
  }

  /** A drag / resize result: same day as the ride, the given car; `endMinutes` absent = keep the ride's length. */
  function moveRide(rideId: string, carId: string, startMinutes: number, endMinutes?: number) {
    const ride = rides.find((r) => r.id === rideId);
    if (!ride?.starts_at || !ride.ends_at || !canDragRide(rideId)) return;
    const duration = (Date.parse(ride.ends_at) - Date.parse(ride.starts_at)) / 60_000;
    const move = moveOnRideDay(ride, carId, startMinutes, endMinutes ?? startMinutes + duration);
    if (move) void saveMove(move);
  }

  function isValidTarget(rideId: string, carId: string, startMinutes: number, endMinutes: number): boolean {
    const ride = rides.find((r) => r.id === rideId);
    const car = carsQuery.data?.find((c) => c.id === carId);
    // A ride that is not mine goes only onto one of my own private cars.
    if (ride && !ownsEditableRide(rideId) && !(movableOntoMyCar(rideId) && myCars.some((own) => own.id === carId))) return false;
    if (!ride || !car || car.status !== "active" || (car.type === "temporary" && car.owner_id !== profileId && carId !== ride.car_id)) return false;
    // A one-way leaves this very car at its destination: it never moves to another car.
    if (carId !== ride.car_id && servedOf(ride).some((entry) => entry.car_mode === "relay")) return false;
    const move = moveOnRideDay(ride, carId, startMinutes, endMinutes);
    if (!move || !isRideDayEditable(move.startsAt, now)) return false;
    const buffer = turnaroundMinutes;
    if (conflictingRides(move, rides, buffer).length) return false;
    if ((maintenanceQuery.data ?? []).some((block) => block.car_id === carId && Date.parse(move.startsAt) < Date.parse(block.ends_at)
      && Date.parse(move.endsAt) + buffer * 60_000 > Date.parse(block.starts_at))) return false;
    const served = servedOf(ride);
    const need = served.reduce((sum, entry) => ({ adults: sum.adults + entry.adults, child: sum.child + entry.child_seats, boosters: sum.boosters + entry.boosters }), { adults: served.length && !served.some((entry) => entry.role === "driver") ? 1 : 0, child: 0, boosters: 0 });
    return (seatsQuery.data ?? []).some((config) => config.car_id === carId && config.adults >= Math.max(1, need.adults) && config.child_seats >= need.child && config.boosters >= need.boosters);
  }

  /** Props for the collision `ConfirmDialog` ("ask the other drivers"). */
  const collisionDialog = {
    open: !!collisionMove,
    onOpenChange: (open: boolean) => { if (!open) setCollisionMove(null); },
    title: he.rideEditing.collisionTitle,
    description: he.rideEditing.collisionBody,
    confirmLabel: he.rideEditing.acknowledge,
    loading: changeMutation.isPending,
    onConfirm: () => {
      if (!collisionMove) return;
      changeMutation.mutate(collisionMove, { onSuccess: () => {
        setCollisionMove(null); onDone?.(); toast.success(he.rideEditing.requested);
      } });
    },
  };

  const ownCarMoveRide = ownCarMove ? rides.find((r) => r.id === ownCarMove.rideId) : undefined;
  const ownCarName = myCars.find((car) => car.id === ownCarMove?.carId)?.name ?? "";
  const ownCarOwnerName = ownCarMoveRide ? (ownCarMoveRide.driver_name ?? servedOf(ownCarMoveRide).find((entry) => entry.requester)?.requester ?? "") : "";
  /** Props for the owner's verification `ConfirmDialog` before a foreign ride lands on their private car. */
  const ownCarDialog = {
    open: !!ownCarMove,
    onOpenChange: (open: boolean) => { if (!open) setOwnCarMove(null); },
    title: tv("rideEditing.ownCarMoveTitle", { name: ownCarOwnerName }),
    description: tv("rideEditing.ownCarMoveBody", { name: ownCarOwnerName, car: ownCarName }),
    confirmLabel: he.rideEditing.ownCarMoveConfirm,
    loading: editMutation.isPending,
    onConfirm: () => {
      const move = ownCarMove;
      setOwnCarMove(null);
      if (move) void persistMove(move);
    },
  };

  return {
    ownsEditableRide,
    canDragRide,
    ownCarDialog,
    saveMove,
    moveRide,
    isValidTarget,
    collisionDialog,
    pendingChanges,
    turnaroundMinutes,
    saving: editMutation.isPending || changeMutation.isPending,
  };
}
