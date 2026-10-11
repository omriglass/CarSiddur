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
import { he } from "@/i18n/he";
import { dateKey } from "@/lib/time";
import { effectiveWeekSettings } from "@/lib/weekSettings";

import type { RideMove } from "./api";
import { useRequestRideChangeMutation, useRideChanges } from "./hooks";
import { servedOf } from "./servedOf";

export interface MemberRideMovesOptions {
  departmentId: string | undefined;
  weekStart: string | undefined;
  /** The shown week's row (phase, published days). */
  week: Pick<Week, "phase" | "published_days" | "settings_overrides"> | null | undefined;
  profileId: string | undefined;
  /** The viewer is a member of this department (only members edit their rides). */
  isMember: boolean;
  now: Date;
  /** After a move was saved or a collision request was sent (e.g. close the open ride sheet). */
  onDone?: () => void;
}

export function useMemberRideMoves({ departmentId, weekStart, week, profileId, isMember, now, onDone }: MemberRideMovesOptions) {
  const queryClient = useQueryClient();
  const boardRidesQuery = useBoardRides(departmentId, weekStart);
  const changesQuery = useRideChanges(departmentId, weekStart);
  const carsQuery = useCars(departmentId);
  const maintenanceQuery = useMaintenanceBlocks(departmentId);
  const seatsQuery = useCarSeatConfigs(departmentId);
  const settingsQuery = useDepartmentSettings(departmentId);
  const editMutation = useEditRideMutation();
  const changeMutation = useRequestRideChangeMutation();
  const [collisionMove, setCollisionMove] = useState<(RideMove & { departmentId: string; weekStart: string }) | null>(null);

  const rides = boardRidesQuery.data ?? [];
  const pendingChanges = changesQuery.data ?? [];
  // REQ §13.108 D1: the shown week's override of the turnaround buffer wins over the department's.
  const turnaroundMinutes = effectiveWeekSettings(settingsQuery.data, week ?? null).turnaroundMinutes;
  const weekEditable = isMember && (week?.phase === "live" || week?.phase === "published");

  /**
   * My own future ride that I drive — keeping the car, or my own one-way (הלוך בלבד, owner 2026-10-11: a relay leg that
   * leaves the car at the destination; never a הקפצה relay leg) — on a published day, with no change request pending.
   * The server's `edit_ride` member branch is the same rule.
   */
  function ownsEditableRide(rideId: string): boolean {
    const ride = rides.find((r) => r.id === rideId);
    if (!ride?.starts_at || !weekEditable) return false;
    if (!(week?.published_days?.includes(dateKey(ride.starts_at)) ?? true)) return false;
    if (servedOf(ride).some((entry) => entry.role !== "driver"
      || !(entry.car_mode === "keep" || (entry.car_mode === "relay" && entry.trip_type === "one_way")))) return false;
    return ride.driver_id === profileId && Date.parse(ride.starts_at) > now.getTime()
      && !pendingChanges.some((c) => c.ride_id === rideId);
  }

  async function saveMove(move: RideMove) {
    const ride = rides.find((r) => r.id === move.rideId);
    if (!ride || !ownsEditableRide(move.rideId) || !departmentId || !weekStart || !ride.origin_id || !ride.destination_id) return;
    if (conflictingRides(move, rides, turnaroundMinutes).length) {
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
    if (!ride?.starts_at || !ride.ends_at || !ownsEditableRide(rideId)) return;
    const duration = (Date.parse(ride.ends_at) - Date.parse(ride.starts_at)) / 60_000;
    const move = moveOnRideDay(ride, carId, startMinutes, endMinutes ?? startMinutes + duration);
    if (move) void saveMove(move);
  }

  function isValidTarget(rideId: string, carId: string, startMinutes: number, endMinutes: number): boolean {
    const ride = rides.find((r) => r.id === rideId);
    const car = carsQuery.data?.find((c) => c.id === carId);
    if (!ride || !car || car.status !== "active" || (car.type === "temporary" && car.owner_id !== profileId)) return false;
    // A one-way leaves this very car at its destination: it never moves to another car.
    if (carId !== ride.car_id && servedOf(ride).some((entry) => entry.car_mode === "relay")) return false;
    const move = moveOnRideDay(ride, carId, startMinutes, endMinutes);
    if (!move || Date.parse(move.startsAt) <= now.getTime()) return false;
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

  return {
    ownsEditableRide,
    saveMove,
    moveRide,
    isValidTarget,
    collisionDialog,
    pendingChanges,
    turnaroundMinutes,
    saving: editMutation.isPending || changeMutation.isPending,
  };
}
