// REQ §13.112 (a)/(b), UX_FLOWS §3.4a "אם אין רכב…": the optional line under the sentence of a single-day
// הלוך-חזור / הלוך בלבד — "אם אין רכב, [הקפצה ▾] ל[צומת חריש] [עד 08:00] ואיסוף משם [ב־19:00]" or "אם אין רכב, [אסתדר ▾]".
// Controlled by the sentence's sheet state (`SentenceFields`); writes the form fields `fallback`, `altPlace`,
// `altArriveBy`, `altPickup`, `altPickupAt` (`planB.ts`).
import { Check } from "lucide-react";
import { useState } from "react";
import { useWatch, type FieldErrors, type UseFormReturn } from "react-hook-form";

import type { DestinationValue } from "@/components/DestinationCombobox";
import { he, tv } from "@/i18n/he";
import type { TimeAnchor } from "@/lib/enums";
import { cn } from "@/lib/utils";

import { earliestPickup, hasAltPlace, planBOffered } from "../../../planB";
import type { RushWindows } from "../../../rushHours";
import type { RequestFormValues } from "../../../schema";
import { arriveByFromDeparture, departFromArriveBy, endEstimate } from "../../../timeAnchors";
import { FieldError } from "../FieldError";
import { planBActions } from "../planBActions";
import { LtrText } from "./LtrText";
import { AnchorTimePicker } from "./AnchorTimePicker";
import { FieldSheet } from "./FieldSheet";
import { PillChip } from "./PillChip";
import { PlacePicker, type PlaceOption } from "./PlacePicker";
import { SentenceChip } from "./SentenceChip";
import type { PlanBSheet } from "./sentenceModel";

interface PlanBLineProps {
  form: UseFormReturn<RequestFormValues>;
  errors: FieldErrors<RequestFormValues>;
  /** The department's places; drop points (`is_drop_point`) are listed first. */
  destinations: readonly { id: string; name: string; aliases: string[]; zone: string; travel_minutes?: number | null; is_drop_point?: boolean }[];
  /** R11U5: the request's origin (a list place) is not offered as a plan-B place. */
  originPlaceId?: string;
  sheet: string | null;
  setSheet: (sheet: PlanBSheet | null) => void;
  /** `route_minutes_preview` from the request's origin to the drop place; `null` while unknown. */
  routeMinutes: number | null;
  /** The request day's rush-hour windows (REQ §13.113). */
  rush: RushWindows;
}

/**
 * The plan-B drop time sheet: the main time picker's anchor toggle ("להגיע עד" default / "לצאת ב־")
 * + estimate line. The stored value is always `arrive_by`; the chosen anchor and the typed
 * departure live only in this component's state, so reopening the sheet shows "להגיע עד" (no DB column).
 */
function PlanBArriveBody({ arriveBy, routeMinutes, rush, onChange, error }: { arriveBy: string; routeMinutes: number | null; rush: RushWindows; onChange: (value: string) => string | null; error?: string }) {
  const [anchor, setAnchor] = useState<TimeAnchor>("arrive");
  const [departure, setDeparture] = useState(() => (routeMinutes != null ? departFromArriveBy(arriveBy, routeMinutes, rush) : arriveBy));
  // R10U4: set when the drop time pushed the pickup along.
  const [movedPickup, setMovedPickup] = useState<string | null>(null);
  const leave = anchor === "leave" && routeMinutes != null;
  const entered = leave ? departure : arriveBy;
  const estimate = routeMinutes != null ? endEstimate("out", leave ? "leave" : "arrive", entered, routeMinutes, rush) : null;
  return (
    <AnchorTimePicker
      anchors={["leave", "arrive"]}
      // R10U5: the toggle is shown before a place is chosen; "לצאת ב־" needs the drive, so it waits for the place.
      disabledAnchors={routeMinutes == null ? ["leave"] : undefined}
      anchor={anchor}
      anchorLabel={(option) => he.requestSentence.anchor[option === "arrive" ? "outArrive" : "outLeave"]}
      onAnchorChange={(next) => {
        if (next === "leave" && routeMinutes != null) setDeparture(departFromArriveBy(arriveBy, routeMinutes, rush));
        setAnchor(next);
      }}
      value={entered}
      onChange={(next) => {
        if (leave && routeMinutes != null) {
          setDeparture(next);
          setMovedPickup(onChange(arriveByFromDeparture(next, routeMinutes, rush)));
        } else setMovedPickup(onChange(next));
      }}
      ariaLabel={he.planB.sheet.arrive}
      dataField="altArriveBy"
      error={error}
      estimate={estimate}
      estimateTestId="plan-b-time-estimate"
      beforeEstimate={
        <>
          {routeMinutes == null ? <p className="text-center text-sm text-muted-foreground" data-testid="plan-b-time-estimate">{he.planB.sheet.estimateUnknown}</p> : null}
          {movedPickup ? (
            <p className="text-center text-sm text-muted-foreground" data-testid="plan-b-pickup-moved">
              <LtrText text={tv("planB.sheet.pickupMoved", { time: movedPickup })} />
            </p>
          ) : null}
        </>
      }
    />
  );
}

function placeName(value: DestinationValue | undefined, destinations: PlanBLineProps["destinations"]): string {
  if (!value) return "";
  if ("presetId" in value) return destinations.find((d) => d.id === value.presetId)?.name ?? value.name;
  return value.freeText;
}

export function PlanBLine({ form, errors, destinations, originPlaceId, sheet, setSheet, routeMinutes, rush }: PlanBLineProps) {
  const values = useWatch({ control: form.control });
  const scope = { tripType: values.tripType ?? "round_trip", day: values.day ?? "", returnDay: values.returnDay };
  if (!planBOffered(scope)) return null;

  const fallback = values.fallback ?? "none";
  const alternative = fallback === "alternative";
  const place = values.altPlace as DestinationValue | undefined;
  const arriveBy = values.altArriveBy ?? "08:00";
  const pickup = !!values.altPickup;
  const pickupAt = values.altPickupAt ?? "";
  const pickupPlace = values.altPickupPlace as DestinationValue | undefined;
  const hasPickupPlace = hasAltPlace(pickupPlace);
  const invalid = (field: keyof RequestFormValues) => field in errors;

  const actions = planBActions(form);
  const set = actions.set;

  function choose(next: "none" | "alternative" | "manage") {
    actions.choose(next);
    setSheet(null);
  }

  function pickPlace(next: DestinationValue) {
    actions.pickPlace(next);
    setSheet(null);
  }

  function pickPickupPlace(next: DestinationValue | undefined) {
    actions.pickPickupPlace(next);
    setSheet(null);
  }

  // Drop points first (stable inside each group), tagged so the member sees why they are on top.
  const places: PlaceOption[] = [
    ...destinations.filter((d) => d.is_drop_point),
    ...destinations.filter((d) => !d.is_drop_point),
  ].filter((d) => d.id !== originPlaceId).map((d) => ({ id: d.id, name: d.name, aliases: d.aliases, zone: d.zone, tag: d.is_drop_point ? he.planB.dropPointTag : undefined }));

  // R10U5: the sheet titles name the place, or show a placeholder until one is chosen.
  const dropName = hasAltPlace(place) ? placeName(place, destinations) : "";
  const arriveTitle = dropName ? tv("planB.sheet.arriveAt", { place: dropName }) : he.planB.sheet.arriveNoPlace;
  const pickupName = hasPickupPlace ? placeName(pickupPlace, destinations) : dropName;
  const pickupTitle = pickupName ? tv("planB.sheet.pickupFromAt", { place: pickupName }) : he.planB.sheet.pickupNoPlace;
  const kindLabel = alternative ? he.planB.kind.alternative : he.planB.kind.manage;
  const kindOptions = [
    { value: "alternative", label: he.planB.options.alternative, hint: he.planB.options.alternativeHint },
    { value: "manage", label: he.planB.options.manage, hint: he.planB.options.manageHint },
    { value: "none", label: he.planB.options.none, hint: he.planB.options.noneHint },
  ] as const;
  const selectedKind = alternative ? "alternative" : fallback === "manage" ? "manage" : "none";
  const errorMessages = [errors.altPlace?.message, errors.altArriveBy?.message, errors.altPickupAt?.message, errors.altPickupPlace?.message].filter(Boolean) as string[];

  return (
    <div className="space-y-1" data-testid="plan-b">
      {fallback === "none" ? (
        <button
          type="button"
          className="relative text-sm text-primary before:absolute before:-inset-2 before:content-[''] hover:underline"
          onClick={() => choose("alternative")}
          data-testid="plan-b-link"
        >
          {he.planB.link}
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-base leading-8" data-testid="plan-b-line">
          <span>{he.planB.prefix}</span>
          <SentenceChip field="fallback" onClick={() => setSheet("planBKind")} data-testid="chip-plan-b-kind">
            {kindLabel}
          </SentenceChip>
          {alternative ? (
            <>
              <span className="inline-flex max-w-full items-center whitespace-nowrap">
                <span className="-me-1">{he.planB.toPrefix}</span>
                <SentenceChip field="altPlace" invalid={invalid("altPlace")} onClick={() => setSheet("planBPlace")} data-testid="chip-plan-b-place">
                  {hasAltPlace(place) ? placeName(place, destinations) : he.planB.placeEmpty}
                </SentenceChip>
              </span>
              <SentenceChip field="altArriveBy" invalid={invalid("altArriveBy")} onClick={() => setSheet("planBArrive")} data-testid="chip-plan-b-arrive">
                <span className="me-1">{he.planB.untilPrefix}</span>
                <span dir="ltr">{arriveBy}</span>
              </SentenceChip>
              {pickup ? (
                <>
                  {/* R10U1: "ואיסוף מ[place]" never splits across lines. */}
                  <span className="inline-flex max-w-full items-center gap-1.5 whitespace-nowrap">
                    <span>{he.planB.pickupWords}</span>
                    <span className="inline-flex min-w-0 items-center">
                      {hasPickupPlace ? <span className="-me-1">{he.planB.pickupFromPrefix}</span> : null}
                      <SentenceChip field="altPickupPlace" invalid={invalid("altPickupPlace")} onClick={() => setSheet("planBPickupPlace")} data-testid="chip-plan-b-pickup-place">
                        {hasPickupPlace ? placeName(pickupPlace, destinations) : he.planB.samePlaceChip}
                      </SentenceChip>
                    </span>
                  </span>
                  <SentenceChip field="altPickupAt" invalid={invalid("altPickupAt")} onClick={() => setSheet("planBPickup")} data-testid="chip-plan-b-pickup">
                    <span dir="ltr">{he.planB.atPrefix}{pickupAt}</span>
                  </SentenceChip>
                </>
              ) : (
                <SentenceChip field="altPickupAt" onClick={() => setSheet("planBPickup")} data-testid="chip-plan-b-pickup">
                  {he.planB.noPickupChip}
                </SentenceChip>
              )}
            </>
          ) : null}
        </div>
      )}
      {errorMessages.map((message) => <FieldError key={message} message={message} />)}

      <FieldSheet open={sheet === "planBKind"} onOpenChange={(open) => !open && setSheet(null)} title={he.planB.sheet.kind} hideFooter testId="plan-b-kind-sheet">
        <div className="space-y-1.5" role="radiogroup" aria-label={he.planB.sheet.kind}>
          {kindOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selectedKind === option.value}
              onClick={() => choose(option.value)}
              data-testid={`plan-b-option-${option.value}`}
              className={cn(
                "flex min-h-11 w-full items-center gap-2 rounded-md border px-3 py-1.5 text-start hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selectedKind === option.value && "border-primary bg-primary/10",
              )}
            >
              <Check className={cn("size-4 shrink-0", selectedKind === option.value ? "opacity-100" : "opacity-0")} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="block text-xs text-muted-foreground">{option.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </FieldSheet>

      <FieldSheet open={sheet === "planBPlace"} onOpenChange={(open) => !open && setSheet(null)} title={he.planB.sheet.place} hideFooter testId="plan-b-place-sheet">
        <PlacePicker places={places} value={hasAltPlace(place) ? (place as DestinationValue) : null} onPick={pickPlace} placeholder={he.planB.placeSearch} />
      </FieldSheet>

      <FieldSheet open={sheet === "planBPickupPlace"} onOpenChange={(open) => !open && setSheet(null)} title={he.planB.sheet.pickupPlace} hideFooter testId="plan-b-pickup-place-sheet">
        <button
          type="button"
          className="flex min-h-10 w-full items-center gap-2 rounded-md border px-3 text-start text-sm hover:bg-accent"
          aria-pressed={!hasPickupPlace}
          onClick={() => pickPickupPlace(undefined)}
          data-testid="plan-b-pickup-same-place"
        >
          <Check className={cn("size-4 shrink-0", hasPickupPlace ? "opacity-0" : "opacity-100")} aria-hidden="true" />
          {he.planB.samePlaceOption}
        </button>
        <PlacePicker places={places} value={hasPickupPlace ? (pickupPlace as DestinationValue) : null} onPick={pickPickupPlace} placeholder={he.planB.placeSearch} />
      </FieldSheet>

      <FieldSheet open={sheet === "planBArrive"} onOpenChange={(open) => !open && setSheet(null)} title={arriveTitle} testId="plan-b-arrive-sheet">
        <PlanBArriveBody arriveBy={arriveBy} routeMinutes={routeMinutes} rush={rush} onChange={actions.setArriveBy} error={errors.altArriveBy?.message ?? errors.altPickupAt?.message} />
      </FieldSheet>

      <FieldSheet open={sheet === "planBPickup"} onOpenChange={(open) => !open && setSheet(null)} title={pickupTitle} testId="plan-b-pickup-sheet">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={pickupTitle}>
          <PillChip pressed={pickup} onClick={() => actions.setPickup(true)} data-testid="plan-b-pickup-on">{he.planB.pickupToggleOn}</PillChip>
          <PillChip pressed={!pickup} onClick={() => actions.setPickup(false)} data-testid="plan-b-pickup-off">{he.planB.pickupToggle}</PillChip>
        </div>
        {pickup ? (
          <AnchorTimePicker
            anchors={null}
            anchor="leave"
            anchorLabel={() => pickupTitle}
            onAnchorChange={() => undefined}
            value={pickupAt || arriveBy}
            min={earliestPickup(arriveBy)}
            onChange={(next) => set.altPickupAt(next)}
            ariaLabel={pickupTitle}
            dataField="altPickupAt"
            error={errors.altPickupAt?.message}
            estimate={null}
            estimateTestId="plan-b-pickup-estimate"
          />
        ) : <FieldError message={errors.altPickupAt?.message} />}
      </FieldSheet>
    </div>
  );
}
