// REQ item 246 h (owner mock board 5): which part of the ride a person rides - "כל הנסיעה" (already chosen),
// "רק הלוך" / "רק חזור", or "עולה או יורד/ת באמצע…" with the on / off places per direction ("לא נוסע/ת בחזור" drops
// one). Shared by "+ נוסע/ת" and the edit dialog (tap a name). The seat line comes from the stops view's free seats;
// the server checks again.
import { Button } from "@/components/ui/button";
import { he } from "@/i18n/he";
import { formatTime } from "@/lib/time";
import type { RouteLeg, RoutePoint } from "@/lib/rideRoute";

import { legPoints, partsFor, type PartChoice, type PersonParts } from "../rideStretches";

export interface RidePartsPickerProps {
  points: readonly RoutePoint[];
  /** The directions this person may ride (the ride's, or their request's on it). */
  legs: readonly RouteLeg[];
  value: PersonParts;
  onChange: (next: PersonParts) => void;
  /** Places they may get on / off at, per leg (positions); all of the leg's places when absent. */
  allowedPositions?: Partial<Record<RouteLeg, readonly number[]>>;
  /** Whether "in the middle" is offered at all (a route with places in the middle, a person whose places count). */
  middle: boolean;
  /** null = no seat line (unknown). */
  room: boolean | null;
}

function Chip({ on, children, onClick, testId, disabled }: { on: boolean; children: React.ReactNode; onClick: () => void; testId?: string; disabled?: boolean }) {
  return (
    <Button type="button" size="sm" variant={on ? "default" : "outline"} aria-pressed={on} onClick={onClick} data-testid={testId} disabled={disabled}
      className="min-h-10 rounded-full">
      {children}
    </Button>
  );
}

export function RidePartsPicker({ points, legs, value, onChange, allowedPositions, middle, room }: RidePartsPickerProps) {
  const choices: PartChoice[] = ["whole", ...(legs.length === 2 ? (["out", "return"] as const) : []), ...(middle ? (["middle"] as const) : [])];
  const pick = (choice: PartChoice) => {
    if (choice === "middle") {
      onChange({ choice, out: value.out ?? (legs.includes("out") ? partsFor("whole", points, legs).out : null), return: value.return ?? (legs.includes("return") ? partsFor("whole", points, legs).return : null) });
    } else onChange(partsFor(choice, points, legs));
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1" role="group" aria-labelledby="ride-part-label">
        <p id="ride-part-label" className="text-sm font-medium">{he.addPassengers.partLabel}</p>
        <div className="flex flex-wrap gap-2">
          {choices.map((choice) => (
            <Chip key={choice} on={value.choice === choice} onClick={() => pick(choice)} testId={`ride-part-${choice}`}>
              {he.addPassengers.part[choice]}
            </Chip>
          ))}
        </div>
      </div>

      {value.choice === "middle"
        ? legs.map((leg) => {
            const pts = legPoints(points, leg);
            const span = value[leg];
            const allowed = allowedPositions?.[leg] ?? pts.map((_, i) => i);
            const setSpan = (next: [number, number] | null) => onChange({ ...value, [leg]: next });
            const last = pts.length - 1;
            return (
              <div key={leg} className="space-y-2 rounded-md border p-2" data-testid={`ride-part-leg-${leg}`}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{he.addPassengers.legTitle[leg]}</p>
                  {legs.length === 2 ? (
                    <Chip on={!span} onClick={() => setSpan(span ? null : [0, last])} testId={`ride-part-skip-${leg}`}>
                      {he.addPassengers.skipLeg[leg]}
                    </Chip>
                  ) : null}
                </div>
                {span ? (
                  <>
                    <p className="text-xs text-muted-foreground">{he.addPassengers.boardAt}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {pts.slice(0, -1).map((point, i) => (allowed.includes(i) ? (
                        <Chip key={i} on={span[0] === i} testId={`ride-part-board-${leg}-${i}`}
                          onClick={() => setSpan([i, span[1] > i ? span[1] : last])}>
                          {point.name}{point.eta ? <span dir="ltr" className="ms-1 tabular-nums">{formatTime(new Date(point.eta))}</span> : null}
                        </Chip>
                      ) : null))}
                    </div>
                    <p className="text-xs text-muted-foreground">{he.addPassengers.alightAt}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {pts.map((point, i) => (i > span[0] && allowed.includes(i) ? (
                        <Chip key={i} on={span[1] === i} testId={`ride-part-alight-${leg}-${i}`} onClick={() => setSpan([span[0], i])}>
                          {point.name}{point.eta ? <span dir="ltr" className="ms-1 tabular-nums">{formatTime(new Date(point.eta))}</span> : null}
                        </Chip>
                      ) : null))}
                    </div>
                  </>
                ) : null}
              </div>
            );
          })
        : null}

      {room == null ? null : (
        <p className={`rounded-md px-2.5 py-1.5 text-sm ${room ? "bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100" : "bg-destructive/10 text-destructive"}`}
          data-testid="ride-part-room">
          {room ? he.addPassengers.room : he.addPassengers.noRoom}
        </p>
      )}
    </div>
  );
}
