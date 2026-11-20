// REQ item 258 (d), owner 2026-11-20: a question about my own rides ("מתי הנסיעה שלי בשבת?", "באיזה רכב הנסיעה שלי ביום
// שני?") changes nothing — the app shows the rides it is about, each with its hours, car, driver and the people on it,
// read from the rides as /my shows them (never the model's prose). "פתיחה" opens the ride's row on /my.
import { Button } from "@/components/ui/button";
import { useSession } from "@/features/auth/useSession";
import { peopleOf } from "@/features/rides/ridePeople";
import { servedOf } from "@/features/rides/servedOf";
import { useMyUpcomingRides } from "@/features/siddur/hooks";
import { he } from "@/i18n/he";

import { rideLabel } from "../draftCard";
import type { AskDraft, AskRide } from "../types";

export function AskRideInfoView({ draft, rides, refs, active, footer, onOpen }: {
  draft: AskDraft;
  rides: readonly AskRide[];
  refs: Record<string, string>;
  active: boolean;
  footer: React.ReactNode;
  onOpen: (requestId: string) => void;
}) {
  const { session } = useSession();
  const upcoming = useMyUpcomingRides();
  const asked = draft.ride_choices.flatMap((ref) => rides.filter((r) => r.ref === ref));

  if (upcoming.isLoading) return <p className="w-fit animate-pulse rounded-2xl bg-muted px-3 py-2 text-sm text-muted-foreground">…</p>;
  if (!asked.length) {
    return <div className="space-y-2 rounded-lg border p-3 text-sm" data-testid="ask-info-none"><p>{he.ask.infoNone}</p>{footer}</div>;
  }

  return (
    <div className="space-y-2" data-testid="ask-info">
      {asked.map((ride) => {
        const requestId = refs[ride.ref];
        const booked = requestId ? (upcoming.data ?? []).find((r) => servedOf(r).some((s) => s.request_id === requestId)) : undefined;
        const others = booked
          ? peopleOf(booked).filter((p) => p.person_id !== session?.user.id && p.source !== "driver").map((p) => p.display_name)
          : ride.people;
        const rows: [string, string][] = [
          [he.ask.infoRow.car, booked?.car_name ?? he.ask.infoNoCar],
          ...(booked?.driver_name && booked.driver_id !== session?.user.id ? [[he.ask.infoRow.driver, booked.driver_name] as [string, string]] : []),
          ...(others.length ? [[he.ask.infoRow.with, others.join(", ")] as [string, string]] : []),
        ];
        return (
          <div key={ride.ref} className="rounded-lg border bg-card p-3" data-testid="ask-info-ride">
            <p className="mb-2 font-semibold" dir="auto">{rideLabel(ride)}</p>
            <dl className="space-y-1 text-sm">
              {rows.map(([label, value]) => (
                <div key={label} className="flex gap-2">
                  <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
                  <dd className="min-w-0">{value}</dd>
                </div>
              ))}
            </dl>
            {active && requestId ? (
              <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => onOpen(requestId)}>{he.ask.infoOpen}</Button>
            ) : null}
          </div>
        );
      })}
      {footer}
    </div>
  );
}
