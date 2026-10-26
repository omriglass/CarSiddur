import { Moon, Sun, Sunrise, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { he, tv } from "@/i18n/he";
import { cn } from "@/lib/utils";

import type { DayPick, PickJoin } from "../rank";

/** Whole day: a half-filled circle (the mockup's stamp). */
function WholeDayIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
    </svg>
  );
}

export function PickIcon({ pick, className }: { pick: DayPick; className?: string }) {
  if (pick === "m") return <Sunrise className={className} aria-hidden="true" />;
  if (pick === "a") return <Sun className={className} aria-hidden="true" />;
  if (pick === "e") return <Moon className={className} aria-hidden="true" />;
  return <WholeDayIcon className={className} />;
}

const PICKS: readonly DayPick[] = ["m", "a", "e", "f"];

interface PlanningHelperProps {
  picks: Partial<Record<number, DayPick>>;
  onPicksChange: (picks: Partial<Record<number, DayPick>>) => void;
  join: PickJoin;
  onJoinChange: (join: PickJoin) => void;
}

/**
 * REQ §13.154 (d): seven day circles; tapping one opens its picker (morning / afternoon / evening / whole day / none).
 * Between the first and last marked day a line: solid = "וגם" (all in one week), dashed = "או" (any one); tap to switch.
 */
export function PlanningHelper({ picks, onPicksChange, join, onJoinChange }: PlanningHelperProps) {
  const [openDay, setOpenDay] = useState<number | null>(null);
  const marked = Object.keys(picks).map(Number).filter((d) => picks[d]).sort((a, b) => a - b);
  const lo = marked[0] ?? -1;
  const hi = marked[marked.length - 1] ?? -1;
  const toggleJoin = () => onJoinChange(join === "and" ? "or" : "and");

  function choose(day: number, pick: DayPick | null) {
    const next = { ...picks };
    if (pick) next[day] = pick;
    else delete next[day];
    onPicksChange(next);
    setOpenDay(null);
  }

  return (
    <section className="space-y-3 rounded-2xl border bg-card p-3 shadow-sm" data-testid="planning-helper">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">{he.planning.helperTitle}</h2>
        {marked.length > 0 ? (
          <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => { onPicksChange({}); setOpenDay(null); }}>
            {he.planning.clearPicks}
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">{he.planning.helperHint}</p>
      <div className="flex items-start">
        {he.days.short.map((letter, day) => {
          const pick = picks[day];
          const linkActive = marked.length >= 2 && day >= lo && day + 1 <= hi;
          return (
            <div key={day} className={cn("flex items-start", day < 6 && "flex-1")}>
              <div className="flex w-10 shrink-0 flex-col items-center gap-1">
                <button
                  type="button"
                  aria-label={he.days.long[day]}
                  aria-expanded={openDay === day}
                  data-testid={`planning-day-${day}`}
                  onClick={() => setOpenDay(openDay === day ? null : day)}
                  className={cn(
                    "flex size-10 items-center justify-center rounded-full transition-colors",
                    pick ? "bg-primary text-primary-foreground shadow" : "bg-muted text-muted-foreground ring-1 ring-inset ring-border",
                    openDay === day && "outline outline-2 outline-offset-2 outline-primary/50",
                  )}
                >
                  {pick ? <PickIcon pick={pick} className="size-5" /> : null}
                </button>
                <span className="text-sm font-semibold text-muted-foreground">{letter}</span>
              </div>
              {day < 6 ? (
                <button
                  type="button"
                  className="mt-[19px] h-1 min-w-1 flex-1"
                  aria-label={he.planning.joinToggle}
                  tabIndex={linkActive ? 0 : -1}
                  disabled={!linkActive}
                  onClick={toggleJoin}
                >
                  <span
                    className={cn(
                      "block w-full border-t-2",
                      linkActive ? (join === "and" ? "border-solid border-primary" : "border-dashed border-primary") : "border-border",
                    )}
                  />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      {openDay !== null ? (
        <div className="space-y-2 rounded-xl bg-primary/5 p-2" data-testid="planning-picker">
          <p className="text-sm font-semibold text-primary">{tv("planning.pickerTitle", { day: he.days.long[openDay] ?? "" })}</p>
          <div className="grid grid-cols-5 gap-1.5">
            {PICKS.map((pick) => (
              <button
                key={pick}
                type="button"
                aria-pressed={picks[openDay] === pick}
                data-testid={`planning-pick-${pick}`}
                onClick={() => choose(openDay, pick)}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-lg text-xs font-medium",
                  picks[openDay] === pick ? "bg-primary text-primary-foreground" : "bg-background",
                )}
              >
                <PickIcon pick={pick} className="size-5" />
                {he.planning.parts[pick]}
              </button>
            ))}
            <button
              type="button"
              data-testid="planning-pick-none"
              onClick={() => choose(openDay, null)}
              className="flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-lg bg-background text-xs font-medium"
            >
              <X className="size-5" aria-hidden="true" />
              {he.planning.partNone}
            </button>
          </div>
        </div>
      ) : null}

      {marked.length >= 2 ? (
        <button
          type="button"
          onClick={toggleJoin}
          data-testid="planning-join"
          className="mx-auto flex min-h-8 items-center gap-2 rounded-full bg-primary/10 px-3 text-sm font-semibold text-primary"
        >
          <span className={cn("inline-block w-6 border-t-2 border-primary", join === "and" ? "border-solid" : "border-dashed")} />
          {join === "and" ? he.planning.joinAnd : he.planning.joinOr}
        </button>
      ) : null}
    </section>
  );
}
