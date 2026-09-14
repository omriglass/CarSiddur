import { toast } from "sonner";

import { CompanionPicker } from "@/components/CompanionPicker";
import { useDepartmentMembers } from "@/features/auth/useDepartmentMembers";
import { useSession } from "@/features/auth/useSession";
import { fetchChildren } from "@/features/requests/api";
import { useQuery } from "@tanstack/react-query";
import { he } from "@/i18n/he";

import { useSetRidePassengersMutation } from "../../hooks";
import { buildRidePassengerInputs } from "../reservationPeople";

import type { RidePassengerEntry } from "../../applySolve";

/**
 * Editing an existing reservation's named people (F3, 20260914120000_ride_passengers.sql)
 * — self-contained like `RidePublicNotesEditor` (owns its own query + mutation), shown in
 * `RideSheet` only for a Sadran-made manual reservation (`pin_reason === 'SADRAN_MANUAL'`)
 * whose notes are already editable there. Unlike the reservation-creation dialog in
 * `BoardScreen`, this never touches `driver_id` — that is set once, at creation, via
 * `edit_ride`; here every picked member/child is a plain `ride_passengers` row.
 */
export function RidePassengersEditor({ rideId, expectedVersion, departmentId, weekStart, initialPassengers }: {
  rideId: string;
  expectedVersion: number;
  departmentId: string;
  weekStart: string;
  initialPassengers: readonly RidePassengerEntry[];
}) {
  const { session } = useSession();
  const profileId = session?.user.id;
  const membersQuery = useDepartmentMembers(departmentId);
  const referenceYear = Number(weekStart.slice(0, 4));
  const childrenQuery = useQuery({
    queryKey: ["children", departmentId, profileId, referenceYear],
    queryFn: () => fetchChildren(departmentId, profileId as string, referenceYear),
    enabled: !!departmentId && !!profileId,
  });
  const mutation = useSetRidePassengersMutation();

  const memberIds = initialPassengers.filter((p) => p.person_id).map((p) => p.person_id as string);
  const childIds = initialPassengers.filter((p) => p.child_id).map((p) => p.child_id as string);

  function save(nextMemberIds: string[], nextChildIds: string[]) {
    const passengers = buildRidePassengerInputs(nextMemberIds, nextChildIds, membersQuery.data ?? [], childrenQuery.data ?? []);
    mutation.mutate({ rideId, expectedVersion, passengers, departmentId, weekStart }, {
      onSuccess: () => toast.success(he.sadranBoard.reservationSaved),
    });
  }

  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-sm font-medium">{he.sadranBoard.reservationPeople}</p>
      <CompanionPicker
        members={(membersQuery.data ?? []).map((m) => ({ id: m.id, name: m.name }))}
        value={memberIds}
        onChange={(nextMemberIds) => save(nextMemberIds, childIds)}
      />
      <CompanionPicker
        members={(childrenQuery.data ?? []).map((child) => ({
          id: child.id,
          name: child.age == null ? child.name : `${child.name} · ${child.age}`,
        }))}
        value={childIds}
        onChange={(nextChildIds) => save(memberIds, nextChildIds)}
        label={he.sadranBoard.reservationChildren}
      />
    </div>
  );
}
