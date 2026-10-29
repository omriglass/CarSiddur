import type { ReactNode } from "react";

import { ConsentChip } from "@/components/ConsentChip";
import type { RideDeltaView } from "@/features/sadran/requestDelta";
import { he, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";

/** The new value of a delta: dark orange text on light orange (theme tokens `delta`, REQ §13.161). */
export function DeltaTag({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("rounded-sm bg-delta-soft px-0.5 font-bold text-delta", className)}>{children}</span>;
}

function pair(start: string | null, end: string | null): string {
  const a = start ? formatTime(new Date(start)) : null;
  const b = end ? formatTime(new Date(end)) : null;
  return a && b ? `${a}–${b}` : (a ?? b ?? "");
}

const PLACE_LABEL = { origin: he.rideDelta.from, destination: he.rideDelta.to, stops: he.rideDelta.via } as const;

interface RideDeltaLineProps {
  view: RideDeltaView | null | undefined;
  className?: string;
}

/**
 * REQ §13.161 (a): what the request asked versus what this ride gave it - hours "old -> new", a changed
 * place, people added or missing - only the beyond-flexibility parts, plus the consent chip (Sadran board only).
 */
export function RideDeltaLine({ view, className }: RideDeltaLineProps) {
  if (!view) return null;
  const { hours, places, added, missing, consent } = view;
  return (
    <span className={cn("flex w-full shrink-0 flex-col items-start gap-0.5 text-[10px] leading-snug", className)} data-testid="ride-delta">
      {hours ? (
        <span dir="ltr" className="flex flex-wrap items-center gap-x-1 tabular-nums">
          <span className="text-muted-foreground line-through">{pair(hours.askedStart, hours.askedEnd)}</span>
          <span aria-hidden="true">→</span>
          <DeltaTag>{pair(hours.gotStart, hours.gotEnd)}</DeltaTag>
        </span>
      ) : null}
      {places.map((place) => (
        <span key={place.kind} className="flex flex-wrap items-center gap-x-1">
          <span>{PLACE_LABEL[place.kind]}</span>
          <span className="text-muted-foreground line-through">{place.asked}</span>
          <DeltaTag>{place.got}</DeltaTag>
        </span>
      ))}
      {added.length || missing.length ? (
        <span className="flex flex-wrap items-center gap-x-1">
          {added.map((name) => <DeltaTag key={`+${name}`}>{tv("rideDelta.added", { name })}</DeltaTag>)}
          {missing.map((name) => <DeltaTag key={`-${name}`}>{tv("rideDelta.missing", { name })}</DeltaTag>)}
        </span>
      ) : null}
      <ConsentChip state={consent} />
    </span>
  );
}
