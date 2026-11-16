import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { CompanionPicker } from "@/components/CompanionPicker";
import { FormDialog } from "@/components/FormDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useDepartmentMembers } from "@/features/auth/useDepartmentMembers";
import { useProfile } from "@/features/auth/useProfile";
import { fetchChildren } from "@/features/requests/api";
import { guestPassengerNames } from "@/features/requests/quickRequest";
import { useSession } from "@/features/auth/useSession";
import { he, t } from "@/i18n/he";

import { parseRideRoute, routeHasIntermediates } from "@/lib/rideRoute";

import { buildAddPassengerInputs } from "../addPassengers";
import { useAddRidePassengersMutation, useRideStretchesQuery } from "../hooks";
import { addPayload, partsFor, rideLegs, roomFor, type PersonParts } from "../rideStretches";
import { RidePartsPicker } from "./RidePartsPicker";

import type { RidePerson } from "../ridePeople";

/**
 * The "+ נוסעים" button (siddur `RideDetailSheet`, board `RideSheet`; REQ §13.85, owner
 * decisions 2026-09-09/2026-09-14): any department member may add named passengers — self,
 * companions, children, or free-text guests — to any published ride, including a private
 * car (posting it means willing to share). Self-contained like `RidePassengersEditor`/
 * `RidePublicNotesEditor` (owns its own queries + mutation); unlike `RidePassengersEditor`
 * (which *replaces* a Sadran reservation's whole people list via `set_ride_passengers()`),
 * this only *appends* via `add_ride_passengers()` and never touches the driver.
 */
export function AddPassengersDialog({ rideId, expectedVersion, departmentId, weekStart, people, disabled, route }: {
  rideId: string;
  expectedVersion: number;
  departmentId: string;
  weekStart: string;
  /** The ride's unified people list (`../ridePeople.ts`) — checked to disable "אני" (and show a
   * hint) when the signed-in member is already on this ride. */
  people: readonly RidePerson[];
  disabled?: boolean;
  /** The ride's route (`BoardRide["route"]`): which part of it the people added here ride (REQ item 246 h). */
  route?: unknown;
}) {
  const [open, setOpen] = useState(false);
  const [includeSelf, setIncludeSelf] = useState(false);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [childIds, setChildIds] = useState<string[]>([]);
  const [guestNames, setGuestNames] = useState("");
  // REQ §13.176 / item 246 h: one part of the ride for everyone added here - all of it (already chosen), one way, or
  // getting on / off in the middle.
  const points = parseRideRoute(route);
  const legs = rideLegs(points);
  const hasMiddle = routeHasIntermediates(points);
  const [parts, setParts] = useState<PersonParts>(() => partsFor("whole", points, legs));
  const stretchesQuery = useRideStretchesQuery(rideId, expectedVersion, open && hasMiddle);

  const { session } = useSession();
  const profileId = session?.user.id;
  const profileQuery = useProfile();
  const membersQuery = useDepartmentMembers(departmentId);
  const referenceYear = Number(weekStart.slice(0, 4));
  const childrenQuery = useQuery({
    queryKey: ["children", departmentId, profileId, referenceYear],
    queryFn: () => fetchChildren(departmentId, profileId as string, referenceYear),
    enabled: open && !!departmentId && !!profileId,
  });
  const mutation = useAddRidePassengersMutation();

  const alreadyOnRide = people.some((person) => !!profileId && person.person_id === profileId);

  function reset() {
    setIncludeSelf(false);
    setMemberIds([]);
    setChildIds([]);
    setGuestNames("");
    setParts(partsFor("whole", points, legs));
  }

  function submit() {
    const passengers = [
      ...(includeSelf && profileId ? [{ person_id: profileId, display_name: profileQuery.data?.full_name ?? "", seat_kind: "adult" as const }] : []),
      ...buildAddPassengerInputs(memberIds, childIds, guestNames, membersQuery.data ?? [], childrenQuery.data ?? []),
    ].map((passenger) => ({ ...passenger, ...(legs.length ? addPayload(parts, points) : { leg: "both" as const }) }));
    if (!passengers.length) return;
    mutation.mutate(
      { rideId, expectedVersion, passengers, departmentId, weekStart },
      {
        onSuccess: () => {
          toast.success(he.addPassengers.added);
          reset();
          setOpen(false);
        },
      },
    );
  }

  const hasPick = includeSelf || memberIds.length > 0 || childIds.length > 0 || guestNames.trim().length > 0;
  // the seat line: adults only (child seats depend on the car's configurations - the server decides those)
  const adults = (includeSelf ? 1 : 0) + memberIds.length + guestPassengerNames(guestNames).length;
  const room = hasMiddle && stretchesQuery.data && hasPick ? roomFor(parts, stretchesQuery.data, adults) : null;

  return (
    <>
      <Button type="button" variant="outline" className="w-full" disabled={disabled} onClick={() => setOpen(true)}>
        {he.addPassengers.button}
      </Button>
      <FormDialog
        open={open}
        onOpenChange={(next) => { if (!mutation.isPending) { setOpen(next); if (!next) reset(); } }}
        title={he.addPassengers.title}
        onSubmit={submit}
        submitLabel={he.addPassengers.submit}
        loading={mutation.isPending}
        submitDisabled={!hasPick || room === false || (!parts.out && !parts.return && legs.length > 0)}
      >
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Checkbox
              id="add-passengers-self"
              checked={includeSelf}
              disabled={alreadyOnRide}
              onCheckedChange={(checked) => setIncludeSelf(checked === true)}
            />
            <Label htmlFor="add-passengers-self" className="font-normal">{he.addPassengers.self}</Label>
            {alreadyOnRide ? <span className="text-xs text-muted-foreground">{he.addPassengers.selfAlreadyOn}</span> : null}
          </div>
          <CompanionPicker
            members={(membersQuery.data ?? []).map((m) => ({ id: m.id, name: m.name }))}
            value={memberIds}
            onChange={setMemberIds}
          />
          <CompanionPicker
            members={(childrenQuery.data ?? []).map((child) => ({
              id: child.id,
              name: child.age == null ? child.name : `${child.name} · ${child.age}`,
            }))}
            value={childIds}
            onChange={setChildIds}
            label={t("field.children")}
          />
          <div className="space-y-1">
            <Label htmlFor="add-passengers-guest-names">{t("quickRequest.guestPassengers")}</Label>
            <Textarea id="add-passengers-guest-names" value={guestNames} onChange={(e) => setGuestNames(e.target.value)} rows={2} />
            <p className="text-xs text-muted-foreground">{t("quickRequest.guestPassengersHelp")}</p>
          </div>
          {legs.length ? (
            <RidePartsPicker points={points} legs={legs} value={parts} onChange={setParts} middle={hasMiddle} room={room} />
          ) : null}
        </div>
      </FormDialog>
    </>
  );
}
