// R20B15 (owner 2026-11-14): the driver taken off a merged ride with nobody driving ("בלי נהג/ת" on the board, or the
// driver's own "הסר רק אותי מהנסיעה — צריך נהג/ת"). When the riders left need fewer hours, ask first: "לקצר את הנסיעה?" —
// shrink to their hours (the usual "הרכב יתפנה לאחרים" check runs before it), keep the ride as it is, or go back.
import { useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { he, tv } from "@/i18n/he";
import { withFreedCarChoice } from "@/lib/appSurface";
import { formatTime } from "@/lib/time";

import { leaveRideFitPreview, type BoardRide } from "./api";
import { FreedCarConfirmDialog } from "./FreedCarConfirmDialog";
import { useLeaveMergedRideFitMutation, useLeaveMergedRideMutation } from "./hooks";
import { useFreedCarGate } from "./useFreedCar";

interface Ask {
  ride: { id: string; version: number; departmentId: string; weekStart: string; startsAt: string; endsAt: string };
  driverName: string;
  fit: { startsAt: string; endsAt: string };
  /** Shown under the question (the Sadran's "הבקשה של X תבוטל…"), when the question replaces that confirmation. */
  note: string | null;
  onDone: () => void;
}

const range = (from: string, until: string) => `${formatTime(new Date(from))}–${formatTime(new Date(until))}`;

export function useLeaveNoDriver() {
  const leave = useLeaveMergedRideMutation();
  const fit = useLeaveMergedRideFitMutation();
  const gate = useFreedCarGate();
  const [ask, setAsk] = useState<Ask | null>(null);
  const [checking, setChecking] = useState(false);

  /**
   * Takes the driver off with nobody driving. Asks "לקצר את הנסיעה?" first when shrinking would change the hours
   * (`note` is shown under it); otherwise leaves at once — or, given `onNoFit`, hands back to the caller's own
   * confirmation instead.
   */
  async function start(ride: BoardRide, driverName: string, onDone: () => void, note: string | null = null, onNoFit?: () => void): Promise<void> {
    if (!ride.id || ride.version == null || !ride.department_id || !ride.week_start || !ride.starts_at || !ride.ends_at) return;
    const base = { id: ride.id, version: ride.version, departmentId: ride.department_id, weekStart: ride.week_start, startsAt: ride.starts_at, endsAt: ride.ends_at };
    setChecking(true);
    let preview: Ask["fit"] | null = null;
    try {
      preview = await leaveRideFitPreview(base.id, base.version);
    } catch {
      preview = null;
    } finally {
      setChecking(false);
    }
    if (!preview) {
      if (onNoFit) onNoFit();
      else keep(base, onDone);
      return;
    }
    setAsk({ ride: base, driverName, fit: preview, note, onDone });
  }

  function keep(ride: Ask["ride"], onDone: () => void) {
    leave.mutate({ rideId: ride.id, expectedVersion: ride.version, newDriver: null, departmentId: ride.departmentId, weekStart: ride.weekStart },
      { onSuccess: onDone });
  }

  function shrink(current: Ask) {
    const { ride } = current;
    const args = { p_ride_id: ride.id, p_expected_version: ride.version };
    void gate.run({ action: "leave_merged_ride_fit", args }, (keepOut) => {
      void withFreedCarChoice(keepOut, () => fit.mutateAsync({ rideId: ride.id, expectedVersion: ride.version, departmentId: ride.departmentId, weekStart: ride.weekStart }))
        .then(current.onDone, () => undefined);
    });
  }

  const busy = checking || leave.isPending || fit.isPending || gate.checking;
  const dialog = (
    <>
      <ConfirmDialog
        open={!!ask}
        onOpenChange={(open) => { if (!open) setAsk(null); }}
        title={he.rideDetail.leaveFitTitle}
        description={ask ? tv("rideDetail.leaveFitBody", { name: ask.driverName, range: range(ask.fit.startsAt, ask.fit.endsAt) }) : undefined}
        cancelLabel={he.freedCar.confirmBack}
        hideConfirm
        loading={busy}
        onConfirm={() => undefined}
      >
        {ask?.note ? <p className="text-sm text-muted-foreground">{ask.note}</p> : null}
        {ask ? (
          <div className="space-y-2">
            <Button className="w-full" disabled={busy} data-testid="leave-fit-shrink"
              onClick={() => { const current = ask; setAsk(null); shrink(current); }}>
              <bdi>{tv("rideDetail.leaveFitShrink", { range: range(ask.fit.startsAt, ask.fit.endsAt) })}</bdi>
            </Button>
            <Button className="w-full" variant="outline" disabled={busy} data-testid="leave-fit-keep"
              onClick={() => { const current = ask; setAsk(null); keep(current.ride, current.onDone); }}>
              <bdi>{tv("rideDetail.leaveFitKeep", { range: range(ask.ride.startsAt, ask.ride.endsAt) })}</bdi>
            </Button>
          </div>
        ) : null}
      </ConfirmDialog>
      <FreedCarConfirmDialog dialog={gate.dialog} />
    </>
  );

  return { start, keep: (ride: BoardRide, onDone: () => void) => {
    if (ride.id && ride.version != null && ride.department_id && ride.week_start && ride.starts_at && ride.ends_at) {
      keep({ id: ride.id, version: ride.version, departmentId: ride.department_id, weekStart: ride.week_start, startsAt: ride.starts_at, endsAt: ride.ends_at }, onDone);
    }
  }, busy, dialog };
}
