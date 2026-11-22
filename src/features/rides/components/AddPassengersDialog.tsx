import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { CompanionPicker } from "@/components/CompanionPicker";
import { ConfirmDialog } from "@/components/ConfirmDialog";
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
import { he, t, tv } from "@/i18n/he";

import { parseRideRoute, routeHasIntermediates } from "@/lib/rideRoute";

import { buildAddPassengerInputs } from "../addPassengers";
import { mergeRefusalOf, withMerges, withoutMerge } from "../addPassengerMatches";
import { fetchRideAddMatches, type RidePassengerInput } from "../api";
import { mergeRefusalReason } from "../useMemberMerge";
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
 *
 * PS1 (owner 2026-11-22): it adds the people, nothing more. A picked member with an open request at these hours is
 * asked about first ("לX יש נסיעה ברשימת המתנה באותו זמן לאותו מקום. להשאיר אותה…?"); the main answer, "הוצא/י אותה
 * מרשימת המתנה", sends the request along, to join as a merge -
 * and a merge the server refuses is said, with the offer to add the person without it (`../addPassengerMatches.ts`).
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
  // PS1: one question at a time over the dialog (its second button, or closing it, is the "no")
  const [question, setQuestion] = useState<{ body: string; yes: string; no: string; resolve: (answer: boolean) => void } | null>(null);
  const [asking, setAsking] = useState(false);
  const ask = (body: string, yes: string, no: string) =>
    new Promise<boolean>((resolve) => setQuestion({ body, yes, no, resolve }));
  const answer = (value: boolean) => {
    question?.resolve(value);
    setQuestion(null);
  };

  const alreadyOnRide = people.some((person) => !!profileId && person.person_id === profileId);

  function reset() {
    setIncludeSelf(false);
    setMemberIds([]);
    setChildIds([]);
    setGuestNames("");
    setParts(partsFor("whole", points, legs));
  }

  async function submit() {
    const picked: RidePassengerInput[] = [
      ...(includeSelf && profileId ? [{ person_id: profileId, display_name: profileQuery.data?.full_name ?? "", seat_kind: "adult" as const }] : []),
      ...buildAddPassengerInputs(memberIds, childIds, guestNames, membersQuery.data ?? [], childrenQuery.data ?? []),
    ].map((passenger) => ({ ...passenger, ...(legs.length ? addPayload(parts, points) : { leg: "both" as const }) }));
    if (!picked.length) return;
    setAsking(true);
    try {
      // PS1: ask about each picked member's own open request at these hours
      const matches = await fetchRideAddMatches(rideId, picked.flatMap((passenger) => (passenger.person_id ? [passenger.person_id] : [])))
        .catch(() => []);
      const yes = new Map<string, string>();
      for (const match of matches) {
        const name = picked.find((passenger) => passenger.person_id === match.personId)?.display_name ?? "";
        const body = match.personId === profileId ? he.addPassengers.matchQuestionSelf : tv("addPassengers.matchQuestion", { name });
        // the main (default) answer takes the request off the waiting list - it joins this ride
        if (await ask(body, he.addPassengers.matchMerge, he.addPassengers.matchKeep)) yes.set(match.personId, match.requestId);
      }
      let passengers = withMerges(picked, yes);
      for (;;) {
        try {
          await mutation.mutateAsync({ rideId, expectedVersion, passengers, departmentId, weekStart });
          break;
        } catch (error) {
          const refused = mergeRefusalOf(error);
          if (!refused) return;   // the mutation already said what went wrong
          const body = tv("addPassengers.mergeRefused", { reason: mergeRefusalReason(refused.code, refused.needs), name: refused.name });
          if (!(await ask(body, he.addPassengers.mergeRefusedYes, he.common.cancel))) return;
          passengers = withoutMerge(passengers, refused.personId);
        }
      }
      toast.success(he.addPassengers.added);
      reset();
      setOpen(false);
    } finally {
      setAsking(false);
    }
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
        onOpenChange={(next) => { if (!mutation.isPending && !asking) { setOpen(next); if (!next) reset(); } }}
        title={he.addPassengers.title}
        onSubmit={() => { void submit(); }}
        submitLabel={he.addPassengers.submit}
        loading={mutation.isPending || asking}
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
      <ConfirmDialog
        open={!!question}
        onOpenChange={(next) => { if (!next) answer(false); }}
        title={he.addPassengers.title}
        description={question?.body}
        confirmLabel={question?.yes}
        cancelLabel={question?.no}
        onConfirm={() => answer(true)}
      />
    </>
  );
}
