// REQ item 258 (d), UX_FLOWS §3.4b "Find a ride": a heading line (day · place · time), the rides the member may join
// (each opens that ride on the siddur, where "+ נוסע/ת" adds them), and a free shared car at that time with
// "בקשה על הרכב הפנוי" (the regular form, filled in). Nothing changes here.
import { useSession } from "@/features/auth/useSession";
import { useProfile } from "@/features/auth/useProfile";
import { useCarSeatConfigs, useDestinations } from "@/features/fleet/hooks";
import { toInstant } from "@/features/requests/mapper";
import { useDepartmentSettings } from "@/features/sadran/hooks";
import { useBoardRides, useWeeks } from "@/features/siddur/hooks";
import { useDayFreeWindows } from "@/features/siddur/useDayFreeWindows";
import { Button } from "@/components/ui/button";
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { formatTime } from "@/lib/time";

import type { TravelLookup } from "../assumedReturn";
import { weekStartOfDay } from "../draftToForm";
import { findFreeCar, findJoinableRides, type FindPlace } from "../findRide";
import type { AskDraft } from "../types";

const hours = (start: string | number | null, end: string | number | null) =>
  start === null ? "" : `${formatTime(new Date(start))}${end === null ? "" : `–${formatTime(new Date(end))}`}`;

/** "HH:MM" the member leaves: an arrive-by time minus the drive. */
function leavingTime(draft: AskDraft, travel: TravelLookup): string | null {
  if (!draft.time) return null;
  if (draft.time_mode !== "arrive_by") return draft.time;
  const minutes = draft.destination?.list_name ? travel(draft.destination.list_name) ?? 0 : 0;
  const [h = 0, m = 0] = draft.time.split(":").map(Number);
  const total = Math.max(0, h * 60 + m - minutes);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function AskFindView({ draft, departmentId, travel, active, footer, onOpenRide, onRequest }: {
  draft: AskDraft;
  departmentId: string;
  travel: TravelLookup;
  active: boolean;
  /** The 👎 button, on the card's last line. */
  footer: React.ReactNode;
  onOpenRide: (rideId: string, weekStart: string, day: string) => void;
  /** "בקשה על הרכב הפנוי" / "בקשה חדשה": the regular form with this draft (as a new request). */
  onRequest: (draft: AskDraft) => void;
}) {
  const day = draft.date as string;
  const weekStart = weekStartOfDay(day);
  const { session } = useSession();
  const profile = useProfile();
  const destinations = useDestinations(departmentId);
  const seatConfigs = useCarSeatConfigs(departmentId);
  const settings = useDepartmentSettings(departmentId);
  const rides = useBoardRides(departmentId, weekStart);
  const weeks = useWeeks(departmentId);
  const free = useDayFreeWindows(departmentId, weekStart, day, new Date());

  const places: FindPlace[] = (destinations.data ?? []).map((d) => ({ id: d.id, name: d.name, lat: d.lat, lng: d.lng }));
  const place = draft.destination?.list_name ? places.find((p) => p.name === draft.destination?.list_name) ?? null : null;
  const time = leavingTime(draft, travel);
  const loading = rides.isLoading || destinations.isLoading || seatConfigs.isLoading || free.isLoading || weeks.isLoading;

  const maxAdults = new Map<string, number>();
  for (const c of seatConfigs.data ?? []) maxAdults.set(c.car_id, Math.max(maxAdults.get(c.car_id) ?? 0, c.adults));
  const joinable = findJoinableRides({
    rides: rides.data ?? [], day, place, placeText: place ? null : draft.destination?.text ?? null, time, places,
    radiusKm: settings.data?.join_radius_km ?? 10, adultSeats: (carId) => maxAdults.get(carId) ?? 0, me: session?.user.id,
  });
  // A free car only on a published week (before that the siddur is not made yet) and for a member who drives.
  const phase = weeks.data?.find((w) => w.week_start === weekStart)?.phase;
  const carsSettled = phase === "published" || phase === "live";
  const freeCar = carsSettled && !profile.data?.does_not_drive
    ? findFreeCar({ freeWindows: free.freeWindows, cars: free.cars, at: time ? Date.parse(toInstant(day, time, false)) : null })
    : null;

  const heading = [formatDayDate(`${day}T12:00:00+02:00`), draft.destination?.list_name ?? draft.destination?.text, draft.time ? tv("ask.findAround", { time: draft.time }) : null]
    .filter(Boolean).join(" · ");

  if (loading) return <p className="w-fit animate-pulse rounded-2xl bg-muted px-3 py-2 text-sm text-muted-foreground">…</p>;

  return (
    <div className="space-y-2" data-testid="ask-find">
      <p className="text-sm font-medium" data-testid="ask-find-heading">{heading}</p>
      {joinable.length ? (
        <div className="rounded-lg border bg-card p-3" data-testid="ask-find-rides">
          <p className="mb-2 font-semibold">{he.ask.findJoinTitle}</p>
          <ul className="space-y-2 text-sm">
            {joinable.slice(0, 5).map(({ ride, freeSeats }) => (
              <li key={ride.id} className="flex items-center gap-2" data-testid="ask-find-ride">
                <div className="min-w-0 flex-1">
                  <p><span dir="ltr">{hours(ride.starts_at, ride.ends_at)}</span> · {ride.destination_name}</p>
                  <p className="text-xs text-muted-foreground">{[ride.driver_name, tv("siddur.freeSeats", { count: String(freeSeats) })].filter(Boolean).join(" · ")}</p>
                </div>
                {active ? (
                  <Button type="button" size="sm" variant="outline" onClick={() => onOpenRide(ride.id as string, weekStart, day)}>
                    {he.addPassengers.button}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {freeCar ? (
        <div className="rounded-lg border bg-card p-3" data-testid="ask-free-car">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="font-semibold">{he.ask.freeCarTitle}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{he.ask.freeCarTag}</span>
          </div>
          <p className="text-sm">{tv("ask.freeCarLine", { car: freeCar.carName, hours: hours(freeCar.start, freeCar.end) })}</p>
          {active ? (
            <Button type="button" size="sm" className="mt-2" data-testid="ask-free-car-request"
              onClick={() => onRequest({ ...draft, intent: "new_request", time: draft.time ?? formatTime(new Date(freeCar.start)), time_mode: draft.time ? draft.time_mode : "depart", ask: null })}>
              {he.ask.freeCarRequest}
            </Button>
          ) : null}
        </div>
      ) : null}
      {!joinable.length && !freeCar ? (
        <div className="space-y-2 rounded-lg border p-3 text-sm" data-testid="ask-find-none">
          <p>{he.ask.findNone}</p>
          {active ? <Button type="button" size="sm" onClick={() => onRequest({ ...draft, intent: "new_request", ask: null })}>{he.ask.findNew}</Button> : null}
        </div>
      ) : null}
      {footer}
    </div>
  );
}
