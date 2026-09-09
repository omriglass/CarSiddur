import { useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { Button } from "@/components/ui/button";
import { TripSummary } from "@/components/TripSummary";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useAllWeekRides, useCarsForDepartment, useWeekRequestsWithNames } from "../hooks";
import { requestDeviations, type DeviationKind } from "./requestDeviations";
import { he } from "@/i18n/he";
import { weekdayLabel } from "@/lib/dayLabels";
import { TZ } from "@/lib/time";

const LABELS: Record<DeviationKind, string> = {
  depart: he.deviations.depart, arrival: he.deviations.arrival, preferredCar: he.deviations.preferredCar,
  passenger: he.deviations.passenger, missingDriver: he.rideCoordination.missingDriver,
  unassigned: he.deviations.unassigned, status: he.deviations.reason,
};
function timeLabel(instant: string) {
  return `${weekdayLabel(instant)} ${formatInTimeZone(instant, TZ, "d/M HH:mm")}`;
}

export function RequestDeviationsDialog({ departmentId, weekStart }: { departmentId: string; weekStart: string }) {
  const [open, setOpen] = useState(false);
  const dept = open ? departmentId : undefined;
  const requests = useWeekRequestsWithNames(dept, weekStart);
  const rides = useAllWeekRides(dept, weekStart);
  const cars = useCarsForDepartment(dept);
  const rows = requestDeviations(requests.data ?? [], rides.data ?? []);
  const loading = requests.isLoading || rides.isLoading || cars.isLoading;
  const failed = requests.isError || rides.isError || cars.isError;
  function value(kind: DeviationKind, raw: string | null | undefined) {
    if (!raw) return "—";
    if (kind === "depart" || kind === "arrival") return timeLabel(raw);
    if (kind === "preferredCar") return cars.data?.find((car) => car.id === raw)?.name ?? "—";
    if (kind === "status") return he.status[raw as keyof typeof he.status] ?? raw;
    return raw;
  }
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button variant="outline">{he.deviations.title}</Button></DialogTrigger>
    <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
      <DialogHeader><DialogTitle>{he.deviations.title}</DialogTitle><DialogDescription>{he.deviations.help}</DialogDescription></DialogHeader>
      {loading ? <p>{he.common.loading}</p> : failed ? <p role="alert">{he.deviations.loadError}</p> : !rows.length ? <p>{he.deviations.empty}</p> : (
        <ul className="space-y-3">{rows.map(({ request, changes }) => <li key={request.id} className="rounded-md border p-3" data-request-deviation={request.id}>
          <TripSummary name={request.requester_full_name ?? he.deviations.noName}
            destination={request.destination_resolved_name ?? request.destination_text} purpose={request.ride_type_name_he}
            departAt={request.original_depart_at ?? request.depart_at} returnAt={request.original_return_at ?? request.return_at} />
          <ul className="mt-2 space-y-1 text-sm">{changes.map((change, index) => <li key={`${change.kind}:${change.rideId}:${index}`} className={change.kind === "missingDriver" ? "font-semibold text-destructive" : undefined}>
            <span className="font-medium">{LABELS[change.kind]}</span>
            {change.original ? <> · {he.deviations.original}: <bdi>{value(change.kind, change.original)}</bdi></> : null}
            {change.current ? <> · {he.deviations.current}: <bdi>{value(change.kind, change.current)}</bdi></> : null}
          </li>)}</ul>
        </li>)}</ul>
      )}
      <DialogClose asChild><Button variant="outline" className="sticky bottom-0 min-h-11 bg-background">{he.common.back}</Button></DialogClose>
    </DialogContent>
  </Dialog>;
}
