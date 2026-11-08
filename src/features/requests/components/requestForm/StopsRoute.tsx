// TODO ST1 (UX_FLOWS "Stops, built 2026-11-08"): the one stops control of both layouts —
// "+ עוד מקום בדרך" (asks which leg only when the trip has a return, then the place picker, all
// inline in this small panel) and the live route line with removable stop chips. Presentational:
// the layout hands in names and a picker renderer, so the classic form (DestinationCombobox) and
// the sentence form (PlacePicker) share the behaviour. The hint under the line is information
// only — it never blocks, prompts or recolours anything (owner 2026-11-08).
import { X } from "lucide-react";
import { useState, type ReactNode } from "react";

import { he, tv } from "@/i18n/he";
import { cn } from "@/lib/utils";

import { activeStopCount, buildRouteLine, type RouteHop, type StopLeg } from "./routeLine";

export const MAX_STOPS = 10;

export interface StopsRouteProps {
  origin: string;
  /** Empty while no destination is chosen yet. */
  destination: string;
  outStops: readonly string[];
  returnStops: readonly string[];
  hasReturn: boolean;
  onRemove: (leg: StopLeg, index: number) => void;
  /** Renders the layout's place picker; call `onPick` when a place is chosen. */
  renderPicker: (onPick: () => void, leg: StopLeg) => ReactNode;
  error?: string;
  /** Class for the wrapper, e.g. spacing. */
  className?: string;
}

type Panel = null | "leg" | StopLeg;

function Hop({ hop, onRemove }: { hop: RouteHop; onRemove: (leg: StopLeg, index: number) => void }) {
  if (!hop.stop) return <span>{hop.label}</span>;
  const { leg, index } = hop.stop;
  return (
    <button
      type="button"
      aria-label={`${he.request.removeStop}: ${hop.label}`}
      data-testid={`route-stop-${leg}`}
      className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-foreground"
      onClick={(event) => { event.stopPropagation(); onRemove(leg, index); }}
    >
      <span className="truncate">{hop.label}</span>
      <X className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

function Hops({ hops, onRemove }: { hops: RouteHop[]; onRemove: (leg: StopLeg, index: number) => void }) {
  return (
    <>
      {hops.map((hop, i) => (
        <span key={`${i}:${hop.label}`} className="inline-flex items-center gap-1">
          {i > 0 ? <span aria-hidden="true" className="rtl:rotate-180">→</span> : null}
          <Hop hop={hop} onRemove={onRemove} />
        </span>
      ))}
    </>
  );
}

export function StopsRoute({ origin, destination, outStops, returnStops, hasReturn, onRemove, renderPicker, error, className }: StopsRouteProps) {
  const [panel, setPanel] = useState<Panel>(null);
  const count = activeStopCount({ outStops, returnStops, hasReturn });
  const outFull = outStops.length >= MAX_STOPS;
  const returnFull = !hasReturn || returnStops.length >= MAX_STOPS;
  const canAdd = !(outFull && returnFull);

  function open() {
    if (!hasReturn) setPanel("out");
    else if (outFull) setPanel("return");
    else if (returnFull) setPanel("out");
    else setPanel("leg");
  }

  const line = count > 0 ? buildRouteLine({ origin, destination: destination || "…", outStops, returnStops, hasReturn }) : null;

  return (
    <div className={cn("space-y-1.5", className)} data-field="outStops">
      {line ? (
        <div className="space-y-1" data-testid="route-line">
          <div
            className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs", canAdd && "cursor-pointer")}
            onClick={canAdd && panel === null ? open : undefined}
          >
            <span className="font-medium">{he.request.routeLine}</span>
            <Hops hops={line.out} onRemove={onRemove} />
            {line.back ? (
              <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground">
                <span aria-hidden="true">·</span>
                <span>{he.request.routeReturn}</span>
                <Hops hops={line.back} onRemove={onRemove} />
              </span>
            ) : null}
            {canAdd ? (
              <button
                type="button"
                aria-label={he.request.addStopAny}
                className="inline-flex size-6 items-center justify-center rounded-full border border-dashed text-primary"
                onClick={(event) => { event.stopPropagation(); if (panel === null) open(); }}
              >
                +
              </button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground" data-testid="stops-hint">{he.request.stopMinutesHint}</p>
        </div>
      ) : null}

      {panel === null ? (
        count === 0 && canAdd ? (
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={open}
            data-testid="add-stop"
          >
            {he.request.addStopAny}
          </button>
        ) : null
      ) : (
        <div className="space-y-2 rounded-md border bg-muted/30 p-2" data-testid="add-stop-panel">
          <p className="text-xs text-muted-foreground">{he.request.stopSheetTitle}</p>
          {panel === "leg" ? (
            <div className="space-y-1.5">
              <p className="text-sm font-medium">{he.request.stopLegQuestion}</p>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" className="h-9 rounded-full border px-3 text-sm hover:bg-accent" data-testid="stop-leg-out" onClick={() => setPanel("out")}>
                  {destination ? tv("request.stopLegOut", { place: destination }) : he.request.stopLegOutPlain}
                </button>
                <button type="button" className="h-9 rounded-full border px-3 text-sm hover:bg-accent" data-testid="stop-leg-return" onClick={() => setPanel("return")}>
                  {origin ? tv("request.stopLegReturn", { place: origin }) : he.request.stopLegReturnPlain}
                </button>
              </div>
            </div>
          ) : (
            renderPicker(() => setPanel(null), panel)
          )}
          <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setPanel(null)}>
            {he.request.stopCancelPick}
          </button>
        </div>
      )}
      {error ? <p role="alert" className="text-sm font-medium text-destructive">{error}</p> : null}
    </div>
  );
}
