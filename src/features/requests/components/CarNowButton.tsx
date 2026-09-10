import { CarFront } from "lucide-react";
import { useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { t, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";

import { roundUpTo15 } from "../carNow";
import { useFreeCarsNowQuery } from "../hooks";
import { QuickRequestSheet } from "./QuickRequestSheet";

export interface CarNowButtonProps {
  departmentId: string;
  className?: string;
}

/**
 * Always-visible "רוצה רכב עכשיו!" entry point (UX_FLOWS.md §18, Home §3.3): always about
 * *today*, never a selected day. Enabled only while a shared car is free right now
 * (`useFreeCarsNowQuery`); opens `QuickRequestSheet` rendering `RequestForm`'s simplified
 * `variant="carNow"`, preselecting the one free car (and hiding the picker) unless more than
 * one is free right now.
 */
export function CarNowButton({ departmentId, className }: CarNowButtonProps) {
  const { isLoading, cars, freeCars, freeWindows, awayWindows, now, weekStart, day } = useFreeCarsNowQuery(departmentId);
  const [open, setOpen] = useState(false);
  const enabled = !isLoading && freeCars.length > 0;
  const initialCarId = freeCars[0]?.id ?? cars[0]?.id ?? "";

  return (
    <>
      <Card
        role={enabled ? "button" : undefined}
        tabIndex={enabled ? 0 : undefined}
        aria-disabled={!enabled}
        className={cn(
          enabled ? "cursor-pointer bg-gradient-card shadow-card transition-smooth hover:shadow-elegant" : "bg-muted/50 shadow-card",
          className,
        )}
        onClick={() => enabled && setOpen(true)}
        onKeyDown={(event) => {
          if (enabled && (event.key === "Enter" || event.key === " ")) setOpen(true);
        }}
      >
        <CardContent className="flex items-center justify-between gap-2 p-4 text-sm">
          <div className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-available/10 text-available">
              <CarFront className="size-5" aria-hidden="true" />
            </span>
            <div>
              <p className="font-medium">{enabled ? t("quickRequest.takeCarNow") : t("quickRequest.noCarNow")}</p>
              {enabled && freeCars.length === 1 ? (
                <p className="text-xs text-muted-foreground">{tv("quickRequest.homeCardSubtitle", { car: freeCars[0]?.name ?? "" })}</p>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>
      {open ? (
        <QuickRequestSheet
          open={open}
          onOpenChange={setOpen}
          departmentId={departmentId}
          weekStart={weekStart}
          day={day}
          initialStartTime={formatTime(roundUpTo15(now))}
          initialCarId={initialCarId}
          showCarPicker={freeCars.length > 1}
          cars={cars}
          freeWindows={freeWindows}
          awayWindows={awayWindows}
          now={now}
          variant="carNow"
        />
      ) : null}
    </>
  );
}
