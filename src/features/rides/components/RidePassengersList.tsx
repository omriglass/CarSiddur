import { useState } from "react";
import { ChevronRight, X } from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { he, tv } from "@/i18n/he";
import { parseRideRoute } from "@/lib/rideRoute";
import { formatTime } from "@/lib/time";

import { canRemoveRidePerson, legMarkedName, type RidePerson } from "../ridePeople";
import { baseRequestId, personDialogSetup, personWhereParts, rideLegs, rideNeedsStretches, type SummaryWords } from "../rideStretches";
import type { ServedEntry } from "../servedOf";
import { useLeaveRideAsGuestMutation, useRemoveRidePassengerMutation, useRideOffRouteMarksQuery, useRideStretchesQuery } from "../hooks";
import { guestRoutePoints } from "../offRoute";
import { useAskRidersLosingPlaces } from "../useAskRidersLosingPlaces";
import { RidePersonDialog } from "./RidePersonDialog";

interface RidePassengersListProps {
  rideId: string | null;
  expectedVersion: number | null;
  people: readonly RidePerson[];
  /** The ride's served requests (`servedOf(ride)`) — a one-way rider reads "נגה (הלוך)" (REQ §13.178). */
  served: readonly ServedEntry[];
  /** Same authorization gate `add_ride_passengers()`/`remove_ride_person()` use — any department
   * member once the ride's week is public, or a Sadran/admin who manages it. Callers already
   * compute this to decide whether to show the "+ נוסע/ת" button (`showAddPassengers`), so it is
   * reused here rather than recomputed. */
  canManagePeople?: boolean;
  rideCancelled?: boolean;
  /** The ride's own `department_id`/`week_start` — scopes cache invalidation after a removal. */
  departmentId?: string | null;
  weekStart?: string | null;
  /** A merged ride on the board: requester and companion rows have no ✕ - removing a requester here withdraws
   * the request, so they leave through "הוצא מהנסיעה" in נסיעות מאוחדות instead (owner 2026-11-09). */
  requestRowsLocked?: boolean;
  /** REQ item 246 h: the ride's route (`BoardRide["route"]`) - each person's part of it in words, tap a name to edit. */
  route?: unknown;
  /** REQ item 246 h (phase 2d): the signed-in member - their own row as a guest on someone else's ride says "לצאת מהנסיעה". */
  viewerId?: string | null;
}

const WHERE_TINT = { on: "text-emerald-800 dark:text-emerald-300", off: "text-rose-800 dark:text-rose-300", plain: "" } as const;

const WORDS: SummaryWords = {
  outOnly: he.addPassengers.part.out,
  returnOnly: he.addPassengers.part.return,
  on: (name, time) => (time ? tv("rideStops.whereOnAt", { name, time }) : tv("rideStops.whereOn", { name })),
  off: (name, time) => (time ? tv("rideStops.whereOffAt", { name, time }) : tv("rideStops.whereOff", { name })),
};

/** People whose part of the ride is edited here (the driver drives it; a requester's part is their request's). */
const EDITABLE = new Set<RidePerson["source"]>(["companion", "child", "guest", "added"]);

/**
 * ONE list of everyone on the ride (owner decision 2026-09-14: "people added directly are
 * indistinguishable at a glance from request-filed ones") — driver first (marked, never
 * removable), then every served request's requester/companions/children/guests and every
 * directly `add_ride_passengers()`-added row, all read from the unified
 * `v_board_rides.people` (`../ridePeople.ts`). REQ item 246 h: the people summary - each name with how they ride
 * when it is not the whole ride ("רק הלוך", "↓ עין שמר (08:15)"), built from the stops view; tapping a name opens
 * how they ride, with "הסרה מהנסיעה" (no separate edit button).
 */
export function RidePassengersList({ rideId, expectedVersion, people, served, canManagePeople = false, rideCancelled = false, departmentId, weekStart, requestRowsLocked = false, route, viewerId }: RidePassengersListProps) {
  const mutation = useRemoveRidePassengerMutation();
  const points = parseRideRoute(route);
  // RP1 (owner 2026-11-21): also a round trip with no stop, so a one-way rider says "רק הלוך" / "רק חזור".
  const needsStretches = rideNeedsStretches(points);
  const stretchesQuery = useRideStretchesQuery(rideId, expectedVersion, needsStretches);
  const stretches = needsStretches ? stretchesQuery.data : undefined;
  const [editing, setEditing] = useState<RidePerson | null>(null);
  const [leaving, setLeaving] = useState<RidePerson | null>(null);
  const leave = useLeaveRideAsGuestMutation();
  // Silent drops item 3: a rider whose get-on / off place is no longer on the route is marked, and taking out a guest
  // whose places others get on / off at asks first.
  const offRoute = useRideOffRouteMarksQuery(rideId, expectedVersion, points.length >= 2).data ?? [];
  const { confirmRidersLosingPlaces, dialog: losingPlacesDialog } = useAskRidersLosingPlaces();
  if (!people.length) return null;
  // the ride's own (main) request: its people do not "leave" a ride that is theirs
  const mainRequest = baseRequestId(points) ?? served.find((entry) => entry.role === "driver")?.request_id ?? null;
  const driverName = people.find((person) => person.source === "driver")?.display_name ?? "";

  const legs = rideLegs(points);
  const time = (iso: string) => formatTime(new Date(iso));
  const canEditRows = canManagePeople && !rideCancelled && rideId != null && expectedVersion != null && legs.length > 0;
  const setup = editing ? personDialogSetup(editing, points, stretches) : null;

  return (
    <div className="space-y-1">
      <span className="font-medium">{he.rideDetail.passengers}</span>
      <ul className="space-y-0.5">
        {people.map((person) => {
          const locked = requestRowsLocked && (person.source === "requester" || person.source === "companion");
          const editable = canEditRows && EDITABLE.has(person.source) && !locked;
          const ownGuestRow = !!viewerId && person.source === "requester" && person.person_id === viewerId && !!person.request_id
            && person.request_id !== mainRequest && rideId != null && expectedVersion != null && !rideCancelled;
          const removable = !editable && !ownGuestRow && rideId != null && expectedVersion != null &&
            canRemoveRidePerson(person, { canManagePeople, rideCancelled }) && !locked;
          const where = stretches ? personWhereParts(person, points, stretches, WORDS, time) : [];
          const name = stretches ? person.display_name.trim() : legMarkedName(person, served);
          const offPlaces = [...new Set(offRoute.filter((mark) => mark.personKey === person.key).map((mark) => mark.place))];
          const label = (
            <span className="min-w-0">
              {name}
              {person.source === "driver" ? ` · ${he.ride.driver}` : ""}
              {offPlaces.length ? (
                <span className="ms-1.5 rounded bg-amber-100 px-1 text-xs font-medium text-amber-950 dark:bg-amber-900/40 dark:text-amber-100" data-testid="ride-person-off-route">
                  {tv("offRoute.mark", { place: offPlaces.join(", ") })}
                </span>
              ) : null}
              {where.length ? (
                <span className="ms-1.5 text-xs text-muted-foreground" data-testid="ride-person-where">
                  {/* Owner 2026-11-17: the same light tint as the stops view - getting on green, getting off reddish. */}
                  {where.map((part, index) => (
                    <span key={index}>
                      {index ? " · " : null}
                      <span className={WHERE_TINT[part.kind]}>{part.text}</span>
                    </span>
                  ))}
                </span>
              ) : null}
            </span>
          );
          return (
            <li key={person.key} className="flex items-center justify-between gap-2" data-person-key={person.key}>
              {editable ? (
                <button type="button" className="flex min-h-9 w-full items-center justify-between gap-2 rounded-md text-start hover:bg-muted"
                  aria-label={tv("addPassengers.editAriaLabel", { name: person.display_name })} onClick={() => setEditing(person)}
                  data-testid="ride-person-edit">
                  {label}
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden="true" />
                </button>
              ) : label}
              {ownGuestRow ? (
                <Button type="button" variant="outline" size="sm" className="shrink-0 text-destructive" data-testid="ride-guest-leave"
                  disabled={leave.isPending} onClick={async () => {
                    if (person.request_id && !(await confirmRidersLosingPlaces(rideId, guestRoutePoints(points, person.request_id)))) return;
                    setLeaving(person);
                  }}>
                  {he.addPassengers.leave}
                </Button>
              ) : null}
              {removable ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6 shrink-0"
                  aria-label={tv("addPassengers.removeAriaLabel", { name: person.display_name })}
                  disabled={mutation.isPending}
                  onClick={async () => {
                    if (rideId == null || expectedVersion == null) return;
                    // a merged guest's own places leave the route with them
                    if (person.source === "requester" && person.request_id && person.request_id !== mainRequest
                        && !(await confirmRidersLosingPlaces(rideId, guestRoutePoints(points, person.request_id)))) return;
                    mutation.mutate(
                      { rideId, expectedVersion, key: person.key, departmentId: departmentId ?? "", weekStart: weekStart ?? "" },
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
      {leaving && rideId != null && expectedVersion != null && leaving.request_id ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => { if (!open && !leave.isPending) setLeaving(null); }}
          title={tv("addPassengers.leaveTitle", { driver: driverName })}
          description={tv("addPassengers.leaveBody", { driver: driverName })}
          confirmLabel={he.addPassengers.leaveConfirm}
          cancelLabel={he.addPassengers.back}
          destructive
          loading={leave.isPending}
          onConfirm={() => leave.mutate(
            { rideId, requestId: leaving.request_id as string, expectedVersion, departmentId: departmentId ?? "", weekStart: weekStart ?? "" },
            { onSuccess: () => { toast.success(he.addPassengers.left); setLeaving(null); } },
          )}
        />
      ) : null}
      {losingPlacesDialog}
      {editing && setup && rideId != null && expectedVersion != null ? (
        <RidePersonDialog
          key={`${editing.key}:${expectedVersion}`}
          open
          onOpenChange={(open) => { if (!open) setEditing(null); }}
          person={editing}
          rideId={rideId}
          expectedVersion={expectedVersion}
          departmentId={departmentId ?? ""}
          weekStart={weekStart ?? ""}
          points={points}
          legs={setup.legs}
          initial={setup.initial}
          stretches={stretches}
          middle={setup.middle}
          allowedPositions={setup.allowedPositions}
          wholeLegsOnly={setup.wholeLegsOnly}
          canRemove={canRemoveRidePerson(editing, { canManagePeople, rideCancelled })}
        />
      ) : null}
    </div>
  );
}
