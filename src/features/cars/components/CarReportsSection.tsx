import { AlertTriangle, ChevronDown, Fuel, Gauge } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { he } from "@/i18n/he";

import { useMyChecklistPromptsQuery } from "../checklist/hooks";

export type CarReportView = "problem" | "tires" | "urea";

/**
 * REQ item 264: the car page's one collapsible "דיווחים" - a problem, tires, urea (diesel), plus the wash and
 * kilometrage cards and, for the car's managers, the car check (`children`). Closed by default; opens by itself
 * while the viewer is asked to complete the car check, so that prompt is never hidden.
 */
export function CarReportsSection({ carId, isDiesel, onReport, children }: {
  carId: string;
  isDiesel: boolean;
  onReport: (view: CarReportView) => void;
  children: ReactNode;
}) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const [wasPrompted, setWasPrompted] = useState(false);
  const prompted = (useMyChecklistPromptsQuery().data ?? []).some((prompt) => prompt.car_id === carId);
  // Stays open after the check is done (the prompt disappears then), until the viewer closes it.
  if (prompted && !wasPrompted) setWasPrompted(true);
  const open = chosen ?? wasPrompted;

  const rows: { view: CarReportView; label: string; icon: ReactNode }[] = [
    { view: "problem", label: he.carCare.homeProblemTitle, icon: <AlertTriangle className="size-5 shrink-0 text-destructive" aria-hidden="true" /> },
    { view: "tires", label: he.carCare.homeTireFillTitle, icon: <Gauge className="size-5 shrink-0 text-maintenance" aria-hidden="true" /> },
    ...(isDiesel ? [{ view: "urea" as const, label: he.carCare.homeUreaFillTitle, icon: <Fuel className="size-5 shrink-0 text-booked" aria-hidden="true" /> }] : []),
  ];

  return (
    <section className="space-y-2" data-testid="car-reports">
      <Card className="bg-gradient-card shadow-card">
        <CardContent className="p-0">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setChosen(!open)}
            data-testid="car-reports-toggle"
            className="flex min-h-12 w-full items-center justify-between gap-3 px-3 text-sm font-medium"
          >
            {he.carPage.reportsTitle}
            <ChevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
          </button>
          {open ? (
            <div className="divide-y border-t">
              {rows.map((row) => (
                <button
                  key={row.view}
                  type="button"
                  onClick={() => onReport(row.view)}
                  data-testid={`car-report-${row.view}`}
                  className="flex min-h-12 w-full items-center gap-3 px-3 text-start text-sm transition-smooth hover:bg-accent/40"
                >
                  {row.icon}
                  {row.label}
                </button>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>
      {open ? children : null}
    </section>
  );
}
