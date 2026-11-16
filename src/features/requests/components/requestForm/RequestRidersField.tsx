// REQ item 246 h (owner mock board 4-5): the people of the request along its route, as text - nothing for the whole
// ride, "רק הלוך" / "רק חזור", else only the differences ("↓ עין שמר · ↑ עין שמר"). Tapping a name opens the same
// choices as on a ride ("כל הנסיעה" / "רק הלוך" / "רק חזור" / "עולה או יורד/ת באמצע…") on the request's own places.
// Shown only when there is a choice to make: someone besides the requester, and a way back or a stop.
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";

import { FormDialog } from "@/components/FormDialog";
import type { DestinationValue } from "@/components/DestinationCombobox";
import { he, tv } from "@/i18n/he";
import { RidePartsPicker } from "@/features/rides/components/RidePartsPicker";
import { legPoints, personWhere, rideLegs, type PersonParts, type SummaryWords } from "@/features/rides/rideStretches";
import type { RidePerson } from "@/features/rides/ridePeople";

import { guestPassengerNames } from "../../quickRequest";
import { requestRoutePoints, riderParts, withRiderParts, type RiderRow } from "../../riders";
import type { RequestFormValues } from "../../schema";
import type { PlaceOption } from "./sentence/PlacePicker";
import { placeName } from "./stopsModel";

const WORDS: SummaryWords = {
  outOnly: he.addPassengers.part.out,
  returnOnly: he.addPassengers.part.return,
  on: (name) => tv("rideStops.whereOn", { name }),
  off: (name) => tv("rideStops.whereOff", { name }),
};

interface Rider {
  key: string;
  name: string;
  seatKind: RiderRow["seat_kind"];
}

export interface RequestRidersFieldProps {
  form: UseFormReturn<RequestFormValues>;
  places: readonly PlaceOption[];
  hasReturn: boolean;
  members: readonly { id: string; name: string }[];
  childOptions: readonly { id: string; name: string; isAdultPassenger?: boolean }[];
}

export function RequestRidersField({ form, places, hasReturn, members, childOptions }: RequestRidersFieldProps) {
  const [origin, destination, outStops, returnStops, companions, children, guestNames, riders] = useWatch({
    control: form.control,
    name: ["origin", "destination", "outStops", "returnStops", "companions", "children", "guestNames", "riders"],
  });
  const [editing, setEditing] = useState<{ rider: Rider; parts: PersonParts } | null>(null);

  const people: Rider[] = [
    ...(companions ?? []).map((id) => ({ key: `companion:${id}`, name: members.find((m) => m.id === id)?.name ?? "", seatKind: "adult" as const })),
    ...(children ?? []).map((id) => {
      const child = childOptions.find((c) => c.id === id);
      return { key: `child:${id}`, name: child?.name ?? "", seatKind: child?.isAdultPassenger ? ("adult" as const) : ("child_seat" as const) };
    }),
    ...guestPassengerNames(guestNames ?? "").slice(0, 20).map((name, i) => ({ key: `guest:${i + 1}`, name, seatKind: "adult" as const })),
  ].filter((p) => p.name.trim());
  const points = requestRoutePoints(
    { origin: origin as DestinationValue, destination: destination as DestinationValue, outStops: (outStops ?? []) as DestinationValue[],
      returnStops: (returnStops ?? []) as DestinationValue[], hasReturn },
    (value) => placeName(value, places),
  );
  const legs = rideLegs(points);
  const hasMiddle = legs.some((leg) => legPoints(points, leg).length > 2);
  if (!people.length || !(legs.length === 2 || hasMiddle)) return null;
  const rows = riders ?? [];

  // the summary words through the ride sheet's reader: each person's spans as a one-person "stops view"
  const where = (rider: Rider) => {
    const parts = riderParts(rider.key, rows, points);
    const person = { key: rider.key, source: "added", request_id: null, display_name: rider.name } as RidePerson;
    const spans = (leg: "out" | "return") => (parts[leg] ? { spans: { [rider.key]: parts[leg] as [number, number] }, absent: [], free: [] } : { spans: {}, absent: [rider.key], free: [] });
    return personWhere(person, points, { out: spans("out"), return: spans("return") }, WORDS, () => "");
  };

  return (
    <div className="space-y-1" data-field="riders" data-testid="request-riders">
      <p className="text-sm font-medium">{he.rideDetail.passengers}</p>
      <ul className="space-y-0.5">
        {people.map((rider) => {
          const text = where(rider);
          return (
            <li key={rider.key}>
              <button type="button" className="flex min-h-9 w-full items-center justify-between gap-2 rounded-md text-start text-sm hover:bg-muted"
                aria-label={tv("addPassengers.editAriaLabel", { name: rider.name })} data-testid="request-rider"
                onClick={() => setEditing({ rider, parts: riderParts(rider.key, rows, points) })}>
                <span className="min-w-0">
                  {rider.name}
                  {text ? <span className="ms-1.5 text-xs text-muted-foreground" data-testid="request-rider-where">{text}</span> : null}
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      {editing ? (
        <FormDialog
          open
          onOpenChange={(open) => { if (!open) setEditing(null); }}
          title={editing.rider.name}
          submitLabel={he.addPassengers.save}
          cancelLabel={he.addPassengers.back}
          submitDisabled={!editing.parts.out && !editing.parts.return}
          onSubmit={() => {
            form.setValue("riders", withRiderParts(rows, editing.rider.key, editing.rider.seatKind, editing.parts, points), { shouldDirty: true });
            setEditing(null);
          }}
        >
          <RidePartsPicker points={points} legs={legs} value={editing.parts} onChange={(parts) => setEditing({ ...editing, parts })}
            middle={hasMiddle} room={null} />
        </FormDialog>
      ) : null}
    </div>
  );
}
