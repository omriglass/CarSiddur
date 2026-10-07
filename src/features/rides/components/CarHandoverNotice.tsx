import { he } from "@/i18n/he";

import { carHandoverLines, type CarHandoverNotes } from "../carHandover";

interface CarHandoverNoticeProps {
  notes: CarHandoverNotes;
  /** This ride's span (a multi-day row: first start .. last end) — decides whether a neighbour needs its day shown. */
  ride: { startsAt: string; endsAt: string };
}

/**
 * "!" + one line per note: "someone takes the car right after you, return it on time" and its mirror "the car
 * arrives just before your ride" (REQ §13.108 f). Display only; renders nothing without notes.
 */
export function CarHandoverNotice({ notes, ride }: CarHandoverNoticeProps) {
  const lines = carHandoverLines(notes, ride);
  if (lines.length === 0) return null;
  return (
    <div className="space-y-1" data-testid="car-handover-notice">
      {lines.map((line) => (
        <p key={line.id} className="flex items-start gap-2 text-sm text-foreground" data-handover={line.id}>
          <span
            role="img"
            aria-label={he.carHandover.alertLabel}
            className="flex size-5 shrink-0 items-center justify-center rounded-full bg-maintenance text-xs font-bold text-maintenance-foreground"
          >
            !
          </span>
          <span className="min-w-0 break-words">
            {line.before}
            {line.day ? <>{line.day} </> : null}
            <span dir="ltr" className="tabular-nums">{line.time}</span>
            {line.after}
          </span>
        </p>
      ))}
    </div>
  );
}
