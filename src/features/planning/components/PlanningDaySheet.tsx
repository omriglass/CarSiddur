import { ChevronLeft, Luggage, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { paths } from "@/app/routes";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { formatTime } from "@/lib/time";

import type { PlanningDay, PlanningReservation } from "../api";
import { useCancelReservationMutation } from "../hooks";
import { placeOf, reservationSummary } from "../summary";

const noonOf = (date: string) => `${date}T12:00:00Z`;

function whenLine(r: PlanningReservation): string {
  const times = [r.departAt, r.returnAt].filter((at): at is string => !!at).map((at) => formatTime(new Date(at))).join("–");
  const days = r.plannedUntil ? `${formatDayDate(noonOf(r.plannedDate))} – ${formatDayDate(noonOf(r.plannedUntil))}` : formatDayDate(noonOf(r.plannedDate));
  return `${days} · ${times}`;
}

function ReservationDetails({ reservation, departmentId, onCancelled }: { reservation: PlanningReservation; departmentId: string; onCancelled: () => void }) {
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancelMutation = useCancelReservationMutation();
  const via = reservation.stops.filter((s) => s.name).map((s) => s.name).join(", ");
  const people = [reservation.requesterName ?? "", ...reservation.companionNames, ...reservation.childNames, ...reservation.guestNames].filter(Boolean);
  const rows: [string, string][] = [
    [he.planning.details.when, whenLine(reservation)],
    [he.planning.details.route, [reservation.originName ? tv("planning.details.from", { place: reservation.originName }) : "", placeOf(reservation)].filter(Boolean).join(" → ")],
    ...(via ? [[he.planning.details.via, via] as [string, string]] : []),
    ...(reservation.rideTypeName ? [[he.planning.details.rideType, reservation.rideTypeName] as [string, string]] : []),
    [he.planning.details.people, `${people.join(", ")} · ${tv("planning.details.seats", { adults: String(reservation.adults), kids: String(reservation.childSeats + reservation.boosters) })}`],
    ...(reservation.rideDescription ? [[he.planning.details.description, reservation.rideDescription] as [string, string]] : []),
  ];
  return (
    <div className="space-y-3" data-testid="planning-reservation-details">
      <dl className="space-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[6rem_1fr] gap-2">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {reservation.hasLuggage ? (
        <p className="flex items-center gap-1 text-sm"><Luggage className="size-4" aria-hidden="true" />{he.planning.details.luggage}</p>
      ) : null}
      {reservation.mine ? (
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" className="min-h-11">
            <Link to={paths.planEdit(departmentId, reservation.id)} data-testid="planning-edit">
              <Pencil className="me-2 size-4" aria-hidden="true" />{he.planning.edit}
            </Link>
          </Button>
          <Button type="button" variant="outline" className="min-h-11 text-destructive" onClick={() => setConfirmCancel(true)} data-testid="planning-cancel">
            <Trash2 className="me-2 size-4" aria-hidden="true" />{he.planning.cancel}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title={he.planning.cancelConfirmTitle}
        description={he.planning.cancelConfirmBody}
        confirmLabel={he.planning.cancel}
        destructive
        loading={cancelMutation.isPending}
        onConfirm={() => cancelMutation.mutate(reservation.id, {
          onSuccess: () => { setConfirmCancel(false); toast.success(he.planning.cancelled); onCancelled(); },
        })}
      />
    </div>
  );
}

interface PlanningDaySheetProps {
  departmentId: string;
  date: string | null;
  day: PlanningDay | undefined;
  reservations: PlanningReservation[];
  plannable: boolean;
  isPast: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * REQ §13.154 (c): a tapped day — its reservations at a glance ("עומרי ל־חיפה"); one tap shows the details like any
 * request, read only (no ask-to-join); my own reservation can be edited or cancelled. A plannable day offers a new
 * reservation; a day of an open week offers a normal request.
 */
export function PlanningDaySheet({ departmentId, date, day, reservations, plannable, isPast, onOpenChange }: PlanningDaySheetProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = reservations.find((r) => r.id === selectedId) ?? null;
  const close = (open: boolean) => { if (!open) setSelectedId(null); onOpenChange(open); };
  return (
    <Sheet open={!!date} onOpenChange={close}>
      <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto sm:mx-auto sm:max-w-lg sm:rounded-t-2xl" data-testid="planning-day-sheet">
        <SheetHeader className="text-start">
          <SheetTitle>{date ? formatDayDate(noonOf(date)) : ""}</SheetTitle>
          <SheetDescription>
            {selected ? reservationSummary(selected) : isPast ? he.planning.dayPast : !plannable ? he.planning.dayOpenWeek : reservations.length === 0 ? he.planning.noReservations : tv("planning.countReservations", { n: String(reservations.length) })}
          </SheetDescription>
        </SheetHeader>
        <div className="mt-3 space-y-3">
          {selected ? (
            <>
              <Button type="button" variant="ghost" size="sm" className="-ms-2" onClick={() => setSelectedId(null)}>
                <ChevronLeft className="me-1 size-4 rotate-180 rtl:rotate-0" aria-hidden="true" />{he.planning.back}
              </Button>
              <ReservationDetails reservation={selected} departmentId={departmentId} onCancelled={() => setSelectedId(null)} />
            </>
          ) : (
            <>
              {reservations.length > 0 ? (
                <ul className="divide-y rounded-lg border" data-testid="planning-day-list">
                  {reservations.map((r) => (
                    <li key={r.id}>
                      <button type="button" className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-start" onClick={() => setSelectedId(r.id)}>
                        <span className="min-w-0 flex-1 truncate">{reservationSummary(r)}</span>
                        {r.mine ? <Badge variant="outline">{he.planning.mine}</Badge> : null}
                        <span className="text-xs text-muted-foreground" dir="ltr">
                          {[r.departAt, r.returnAt].filter((at): at is string => !!at).map((at) => formatTime(new Date(at))).join("–")}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {date && plannable ? (
                <Button asChild className="min-h-11 w-full">
                  <Link to={paths.planReserve(departmentId, date)} data-testid="planning-reserve">
                    <Plus className="me-2 size-4" aria-hidden="true" />{he.planning.reserveDay}
                  </Link>
                </Button>
              ) : date && day && !isPast && (day.phase === "open" || day.phase === "published" || day.phase === "live") ? (
                <Button asChild variant="outline" className="min-h-11 w-full">
                  <Link to={paths.requests.new({ day: date })}>
                    <Plus className="me-2 size-4" aria-hidden="true" />{he.planning.requestDay}
                  </Link>
                </Button>
              ) : null}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
