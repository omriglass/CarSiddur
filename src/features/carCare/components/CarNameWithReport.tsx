import { CarFront } from "lucide-react";
import { useState } from "react";

import { tv } from "@/i18n/he";
import { cn } from "@/lib/utils";

import { CarReportDialog } from "./CarReportDialog";

export interface CarNameWithReportProps {
  carId: string;
  carName: string;
  className?: string;
}

/**
 * Car name, preceded by its own car icon (`CarFront`) doubling as the
 * "דיווח על רכב" trigger that opens `CarReportDialog` (REQUIREMENTS §6.6,
 * UX_FLOWS §3.9) — no separate button/wrench glyph. Used everywhere a car's
 * name shows on a member surface — never on the Sadran board or board
 * sheets (those keep a plain car name; the report dialog is a member
 * self-service action, not a coordination one).
 *
 * The icon control is a `span role="button"`, not a nested `<button>`: every
 * current call site (`RideCard`, `RideDetailSheet`) can itself sit inside a
 * clickable card/row, and a `<button>` nested inside another interactive
 * element (or a `div role="button"` with its own `onClick`/`onKeyDown`, as
 * `RideCard`'s `Card` is) is exactly the "button-in-button" shape to avoid —
 * `stopPropagation`/`preventDefault` here keep the parent's click/keydown
 * handlers from also firing. The negative margin cancels out the extra
 * padding visually so the icon still looks its usual small size while its
 * tap target is >= 40px, per CLAUDE.md's mobile-first tap-target guidance.
 */
export function CarNameWithReport({ carId, carName, className }: CarNameWithReportProps) {
  const [open, setOpen] = useState(false);
  const label = tv("carCare.dialogTitle", { car: carName });

  function openDialog() {
    setOpen(true);
  }

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
      <span
        role="button"
        tabIndex={0}
        aria-label={label}
        title={label}
        data-testid="car-name-report-trigger"
        className="-m-[13px] inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full p-[13px] text-muted-foreground transition-smooth hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={(event) => {
          event.stopPropagation();
          openDialog();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          openDialog();
        }}
      >
        <CarFront className="size-3.5" aria-hidden="true" />
      </span>
      <span className="truncate">{carName}</span>
      <CarReportDialog carId={carId} carName={carName} open={open} onOpenChange={setOpen} />
    </span>
  );
}
