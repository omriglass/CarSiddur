// UX_FLOWS §3.4a "Sentence layout": the field block of `RequestForm` (REQ §13.110) — the request
// as one sentence of tappable chips (who travels first), each opening a bottom sheet for its
// field. Weekly requests have two stages: stage 1 = the sentence, stage 2 (`StageTwo`) = the
// modifiers that are not in it. Everything shares the classic layout's form state, schema and
// submit pipeline; only the field arrangement differs.
import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Controller, useWatch, type FieldErrors, type UseFormReturn } from "react-hook-form";

import type { DestinationPreset, DestinationValue } from "@/components/DestinationCombobox";
import { RideTypeChips } from "@/components/RideTypeChips";
import { FormItem } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { he, t, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { cn } from "@/lib/utils";

import { CAR_NOW_DEFAULT_HOURS } from "../../../carNow";
import { guestPassengerNames } from "../../../quickRequest";
import { planBActive, planBOffered } from "../../../planB";
import { planBRecapLine } from "../../../fallbackLine";
import { toInstant } from "../../../mapper";
import { whoText } from "../../../whoLabel";
import type { RequestFormValues } from "../../../schema";
import type { RushWindows } from "../../../rushHours";
import { anchorLabelKey, endEstimate, enteredOutTime, enteredReturnTime } from "../../../timeAnchors";
import {
  WINDOW_EARLIEST_START,
  WINDOW_LATEST_END,
  WINDOW_MAX_HOURS,
  WINDOW_QUICK_HOURS,
  defaultWindowFromFixed,
  windowEndKeepingSlack,
  windowHoursLabel,
  windowModeActive,
  windowOffered,
} from "../../../timeWindow";
import { CarPreferenceFields } from "../CarPreferenceFields";
import { DayAndTripShapeFields } from "../DayAndTripShapeFields";
import { FieldError } from "../FieldError";
import { QuickFreeCarWarning, QuickTimeHints } from "../TimesFlexibilityFields";
import { TripTypeFields } from "../TripTypeFields";
import { PlanBLine } from "./PlanBLine";
import { FieldSheet } from "./FieldSheet";
import { FlexibilityRow } from "./FlexibilityRow";
import { LtrText } from "./LtrText";
import { PillChip } from "./PillChip";
import { PlacePicker } from "./PlacePicker";
import { SentenceChip } from "./SentenceChip";
import { StageTwo } from "./StageTwo";
import { estimateLine } from "./estimateLine";
import { TimeAnchorSheet } from "./TimeAnchorSheet";
import { TimeField15 } from "@/components/TimeField15";
import { WhoSheet } from "./WhoSheet";
import { flexBriefText } from "../../../flexText";
import { flexBrief, invalidTargetOf, type SentenceSheet } from "./sentenceModel";

const HINT_STORAGE_KEY = "carshare.requestSentenceHintDismissed";
const CAR_NOW_QUICK_HOURS = [1, 2, 3, 4, 6] as const;
const MAX_STOPS = 10;

function readHintDismissed(): boolean {
  try {
    return window.localStorage.getItem(HINT_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function dismissHint() {
  try {
    window.localStorage.setItem(HINT_STORAGE_KEY, "1");
  } catch {
    /* private mode: the hint just shows again next time */
  }
}

type SheetKey = SentenceSheet | "stop" | "returnStop" | "duration";

export interface SentenceFieldsProps {
  form: UseFormReturn<RequestFormValues>;
  variant: "weekly" | "quick" | "carNow";
  weekStart: string;
  /** For the route preview of a plan-B הקפצה switch (`TripTypeFields`). */
  departmentId?: string;
  day: string;
  errors: FieldErrors<RequestFormValues>;
  destinations: { id: string; name: string; aliases: string[]; zone: string; travel_minutes?: number | null; is_drop_point?: boolean }[];
  rideTypes: { id: string; name_he: string; code?: string | null }[];
  preferredCars: { id: string; name: string }[];
  initialPreferredCarName: string | null | undefined;
  members: { id: string; name: string }[];
  childOptions: { id: string; name: string; age: number | null; isPriority?: boolean }[];
  tripShape: RequestFormValues["tripShape"];
  tripType: RequestFormValues["tripType"];
  dropOffPickup: boolean;
  canDrive: boolean;
  seeksDriver: boolean;
  isQuickContext: boolean;
  showReturnDayPicker: boolean;
  returnAnotherDay: boolean;
  setReturnAnotherDay: (open: boolean) => void;
  isMultiDay: boolean;
  multiDaySpan: number | null;
  /** `route_minutes_preview` of each leg; `null` while unknown. */
  routeMinutes: { out: number | null; return: number | null; planB: number | null };
  /** The request day's rush-hour windows (REQ §13.113); empty = none. */
  rush: RushWindows;
  recentDestinations: DestinationValue[];
  /** Profile ids that travelled with the member on their own recent requests (newest first). */
  recentCompanionIds: readonly string[];
  /** Weekly sentence layout only: 1 = the sentence, 2 = the modifiers. */
  stage: 1 | 2;
  onStageChange: (stage: 1 | 2) => void;
  /** Set by a failed submit: the first invalid rhf field (`n` changes every time). */
  invalidSignal: { field: string; n: number } | null;
  /** `new` / `edit` — the childcare ride-type suggestion only applies to a new request. */
  mode: "new" | "edit";
  /** Seat-fit / overlap warnings, rendered right under the sentence (R9U4). */
  notices?: ReactNode;
  /** A named child was just added to the request (R9U7). */
  onChildAdded?: () => void;
  quickContext?: { cars: readonly { id: string; name: string }[]; showCarPicker?: boolean };
  quickWindow: { startMs: number; endMs: number; carIsFree: boolean; isAway: boolean; otherFreeCar: { id: string; name: string } | undefined; oneWay: boolean };
}

function placeLabel(value: DestinationValue | null | undefined, destinations: readonly DestinationPreset[]): string {
  if (!value) return "";
  if ("presetId" in value) return destinations.find((d) => d.id === value.presetId)?.name ?? value.name;
  return value.freeText;
}

/** The quick sheet's one collapsible row (the public ride description). */
function DetailRow({ label, value, open, onToggle, testId, children }: { label: string; value: string; open: boolean; onToggle: () => void; testId: string; children?: ReactNode }) {
  return (
    <div className="border-y" data-testid={testId}>
      <button type="button" className="flex min-h-10 w-full items-center justify-between gap-2 py-1.5 text-start text-sm" aria-expanded={open} onClick={onToggle}>
        <span className="min-w-0 truncate">
          <span className="text-muted-foreground">{label}: </span>
          <span className="font-medium">{value}</span>
        </span>
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open ? <div className="space-y-3 pb-3">{children}</div> : null}
    </div>
  );
}

/** A prefix letter / trailing punctuation glued to its chip ("מ" + "גבעת חביבה" + ","): never wrapped apart. */
function Seg({ prefix, suffix, loose, spaced, children }: { prefix?: string; suffix?: string; /** A prefix that ends in a maqaf keeps its own space. */ loose?: boolean; /** A whole word before the chip ("via"): a real gap, since the flex item eats its trailing space (R11U10). */ spaced?: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center whitespace-nowrap">
      {prefix ? <span className={spaced ? "me-1.5" : loose ? undefined : "-me-1"}>{prefix}</span> : null}
      {children}
      {suffix ? <span>{suffix}</span> : null}
    </span>
  );
}

export function SentenceFields(props: SentenceFieldsProps) {
  const {
    form, variant, weekStart, departmentId, day, errors, destinations, rideTypes, preferredCars, initialPreferredCarName, members, childOptions,
    tripShape, tripType, dropOffPickup, canDrive, seeksDriver, isQuickContext, showReturnDayPicker,
    returnAnotherDay, setReturnAnotherDay, isMultiDay, multiDaySpan, routeMinutes, rush, recentDestinations, recentCompanionIds, stage, onStageChange,
    invalidSignal, quickContext, quickWindow, notices, onChildAdded, mode,
  } = props;
  const control = form.control;
  const values = useWatch({ control });

  // A quick/car-now sheet opens straight on the destination, like the classic form's autofocused combobox.
  const [sheet, setSheet] = useState<SheetKey | null>(variant === "weekly" ? null : "destination");
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [hintVisible, setHintVisible] = useState(() => !readHintDismissed());
  const [handledSignal, setHandledSignal] = useState(0);

  // A failed submit / "המשך" opens the sheet of the first bad stage-1 field (adjusted during render, no effect).
  if (invalidSignal && invalidSignal.n !== handledSignal) {
    setHandledSignal(invalidSignal.n);
    const target = invalidTargetOf(invalidSignal.field);
    if (target?.kind === "sheet") setSheet(target.sheet);
    if (target?.kind === "row") {
      if (target.row === "description") setDescriptionOpen(true);
      else setNotesOpen(true);
    }
  }

  const isWeekly = variant === "weekly";
  const hasOut = tripShape !== "one_way_from";
  const hasReturn = tripShape !== "one_way_to";
  const isPickup = tripType === "drop_off";
  // REQ §13.112 (c): "N hours between A and B" replaces the two time chips (weekly, single-day round trip only).
  const windowScope = { tripType, tripShape, day, returnDay: values.returnDay };
  const canWindow = isWeekly && !isMultiDay && windowOffered(windowScope);
  const windowOn = canWindow && windowModeActive({ ...windowScope, timeMode: values.timeMode });
  const windowHours = values.windowHours ?? 4;
  const windowStart = values.windowStart ?? "08:00";
  const windowEnd = values.windowEnd ?? "12:00";
  const [moreWindowHours, setMoreWindowHours] = useState(false);
  const anchorsEnabled = isWeekly && !isMultiDay;
  const flexEnabled = isWeekly && !isMultiDay;
  const departAnchor = anchorsEnabled ? (values.departAnchor ?? "leave") : "leave";
  const returnAnchor = anchorsEnabled ? (values.returnAnchor ?? "arrive") : "arrive";
  const outTime = enteredOutTime({ departAnchor, arriveByTime: values.arriveByTime, departTime: values.departTime }) ?? "08:00";
  const returnTime = enteredReturnTime({ returnAnchor, leaveDestTime: values.leaveDestTime, returnTime: values.returnTime }) ?? "12:00";
  const outStops = (values.outStops ?? []) as DestinationValue[];
  const destinationValue = values.destination as DestinationValue | undefined;
  const hasDestination = !!destinationValue && ("presetId" in destinationValue ? !!destinationValue.presetId : destinationValue.freeText.trim() !== "");
  const originName = placeLabel(values.origin as DestinationValue | undefined, destinations) || he.field.origin;
  const destinationName = hasDestination ? placeLabel(destinationValue, destinations) : he.requestSentence.destinationPlaceholder;

  const invalid = (...fields: string[]) => fields.some((field) => field in errors);
  const dayInstant = toInstant(day, "12:00", false);
  const returnDay = values.returnDay ?? day;
  const dayText = tv("requestSentence.dayChip", {
    day: isMultiDay ? tv("requestSentence.dayRange", { from: formatDayDate(dayInstant), to: formatDayDate(toInstant(returnDay, "12:00", false)) }) : formatDayDate(dayInstant),
  });
  const dropOffPickupOn = isPickup && hasReturn;
  const tripLabel = { round_trip: he.request.tripTypeRoundTrip, one_way: he.request.tripTypeOneWay, drop_off: dropOffPickupOn ? he.requestSentence.tripDropOffPickup : he.request.tripTypeDropOff }[tripType];

  // Who travels: the requester, named companions and children, guests — the sentence's first chip.
  const memberName = new Map(members.map((member) => [member.id, member.name]));
  const childName = new Map(childOptions.map((child) => [child.id, child.name]));
  const companionIds = (values.companions ?? []) as string[];
  const childIds = (values.children ?? []) as string[];
  const guests = guestPassengerNames(values.guestNames ?? "");
  const travellers = [
    he.requestSentence.me,
    ...companionIds.map((id) => memberName.get(id)).filter((name): name is string => !!name),
    ...childIds.map((id) => childName.get(id)).filter((name): name is string => !!name),
    ...guests,
  ];
  const extraAdults = values.extraAdults ?? 0;
  // REQ §13.112 (d): children without a name, a child seat or a booster each.
  const unnamedChildSeats = values.legacyChildSeats ?? 0;
  const unnamedBoosters = values.boosters ?? 0;
  const unnamedChildren = unnamedChildSeats + unnamedBoosters;
  const whoLabel = whoText(travellers, extraAdults, unnamedChildren);
  const needsVerb = travellers.length > 1 || extraAdults > 0 || unnamedChildren > 0 ? he.requestSentence.needsPlural : he.requestSentence.needs;

  function timeChip(end: "out" | "return") {
    const anchor = end === "out" ? departAnchor : returnAnchor;
    const entered = end === "out" ? outTime : returnTime;
    const brief = flexEnabled
      ? end === "out" ? flexBrief(values.flexDepartEarly ?? 0, values.flexDepartLate ?? 0) : flexBrief(values.flexReturnEarly ?? 0, values.flexReturnLate ?? 0)
      : ({ kind: "none" } as const);
    const briefText = flexBriefText(brief);
    return (
      <SentenceChip
        field={end === "out" ? "departTime" : "returnTime"}
        invalid={end === "out" ? invalid("departTime", "arriveByTime") : invalid("returnTime", "leaveDestTime")}
        onClick={() => setSheet(end)}
        data-testid={`chip-${end}`}
      >
        <span className="me-1">{he.requestSentence.anchor[anchorLabelKey(end, anchor, isPickup)]}</span>
        <span dir="ltr">{entered}</span>
        {briefText ? <span className="ms-1">· {briefText}</span> : null}
      </SentenceChip>
    );
  }

  // Derived line: only an end anchored away from the car time ("יציאה משוערת 08:45 · 45 דק׳ נסיעה").
  const derivedLines: string[] = [];
  if (!windowOn && anchorsEnabled && hasOut && departAnchor === "arrive" && routeMinutes.out != null) {
    derivedLines.push(estimateLine(endEstimate("out", "arrive", outTime, routeMinutes.out, rush)));
  }
  if (!windowOn && anchorsEnabled && hasReturn && returnAnchor === "leave" && routeMinutes.return != null) {
    derivedLines.push(estimateLine(endEstimate("return", "leave", returnTime, routeMinutes.return, rush)));
  }

  const textOrDash = (text: string | undefined) => (text && text.trim() ? text.trim() : he.requestSentence.empty);

  function pickPlace(name: "origin" | "destination", value: DestinationValue) {
    form.setValue(name, value, { shouldDirty: true, shouldValidate: true });
    setSheet(null);
  }

  function addStop(value: DestinationValue) {
    const current = (form.getValues("outStops") ?? []) as DestinationValue[];
    if (current.length < MAX_STOPS) form.setValue("outStops", [...current, value], { shouldDirty: true, shouldValidate: true });
    setSheet(null);
  }

  function removeStop(index: number) {
    const current = (form.getValues("outStops") ?? []) as DestinationValue[];
    form.setValue("outStops", current.filter((_, i) => i !== index), { shouldDirty: true, shouldValidate: true });
  }

  const returnStops = (values.returnStops ?? []) as DestinationValue[];

  function addReturnStop(value: DestinationValue) {
    const current = (form.getValues("returnStops") ?? []) as DestinationValue[];
    if (current.length < MAX_STOPS) form.setValue("returnStops", [...current, value], { shouldDirty: true, shouldValidate: true });
    setSheet(null);
  }

  function removeReturnStop(index: number) {
    const current = (form.getValues("returnStops") ?? []) as DestinationValue[];
    form.setValue("returnStops", current.filter((_, i) => i !== index), { shouldDirty: true, shouldValidate: true });
  }

  function enterWindowMode() {
    const fixed = form.getValues();
    if (!fixed.windowHours || !fixed.windowStart || !fixed.windowEnd) {
      const window = defaultWindowFromFixed({ departTime: fixed.departTime, returnTime: fixed.returnTime });
      form.setValue("windowHours", window.windowHours, { shouldDirty: true });
      form.setValue("windowStart", window.windowStart, { shouldDirty: true });
      form.setValue("windowEnd", window.windowEnd, { shouldDirty: true });
    }
    form.setValue("timeMode", "window", { shouldDirty: true, shouldValidate: true });
  }

  function leaveWindowMode() {
    form.setValue("timeMode", "fixed", { shouldDirty: true, shouldValidate: true });
    void form.trigger(["departTime", "returnTime", "windowEnd"]);
  }

  /** Hours or start changed: the window's end follows, keeping the slack (never an unexplained "window too short"). */
  function changeWindow(next: { windowHours?: number; windowStart?: string }) {
    const before = { windowHours, windowStart, windowEnd };
    const hours = next.windowHours ?? windowHours;
    const start = next.windowStart ?? windowStart;
    form.setValue("windowHours", hours, { shouldDirty: true, shouldValidate: true });
    form.setValue("windowStart", start, { shouldDirty: true, shouldValidate: true });
    form.setValue("windowEnd", windowEndKeepingSlack(before, { windowHours: hours, windowStart: start }), { shouldDirty: true, shouldValidate: true });
  }

  function setFlexBoth(early: RequestFormValues["flexDepartEarly"], late: RequestFormValues["flexDepartLate"]) {
    for (const name of ["flexDepartEarly", "flexReturnEarly"] as const) form.setValue(name, early, { shouldDirty: true });
    for (const name of ["flexDepartLate", "flexReturnLate"] as const) form.setValue(name, late, { shouldDirty: true });
  }

  if (isWeekly && stage === 2) {
    // R9M2: an end entered as an anchor ("arrive by" / "leave there at") is labelled in the recap.
    const anchored = departAnchor === "arrive" || returnAnchor === "leave";
    const recapPieces: string[] = [];
    if (anchored) {
      if (hasOut) recapPieces.push(tv(departAnchor === "arrive" ? "requestSentence.recapArriveBy" : "requestSentence.recapLeave", { time: outTime }));
      if (hasReturn) {
        const key = returnAnchor === "leave"
          ? isPickup ? "requestSentence.recapPickupLeave" : "requestSentence.recapLeaveThere"
          : isPickup ? "requestSentence.recapPickupHomeBy" : "requestSentence.recapHomeBy";
        recapPieces.push(tv(key, { time: returnTime }));
      }
    }
    const plainTimes = [hasOut ? outTime : null, hasReturn ? returnTime : null].filter((time): time is string => !!time).join("–");
    const recapDay = isMultiDay
      ? tv("requestSentence.dayRange", { from: formatDayDate(dayInstant), to: formatDayDate(toInstant(returnDay, "12:00", false)) })
      : formatDayDate(dayInstant);
    // REQ §13.112 (a)/(b): the "אם אין רכב" line, when the request offers one.
    const planBScope = { tripType, day, returnDay: values.returnDay };
    const planBLine = planBOffered(planBScope)
      ? planBRecapLine({ fallback: values.fallback, altArriveBy: values.altArriveBy, altPickup: values.altPickup, altPickupAt: values.altPickupAt }, planBActive({ ...planBScope, fallback: values.fallback }) ? placeLabel(values.altPlace as DestinationValue | undefined, destinations) : "", values.altPickup ? placeLabel(values.altPickupPlace as DestinationValue | undefined, destinations) : "")
      : null;
    // R11U6: the stops of each leg ("דרך חדרה", "בחזור דרך …") belong to the recap too.
    const viaPieces = [
      outStops.length > 0 ? `${he.requestSentence.via} ${outStops.map((stop) => placeLabel(stop, destinations)).join(", ")}` : null,
      hasReturn && returnStops.length > 0 ? tv("requestSentence.recapReturnVia", { names: returnStops.map((stop) => placeLabel(stop, destinations)).join(", ") }) : null,
    ].filter((piece): piece is string => !!piece);
    const recap = (
      <span className="flex min-w-0 flex-col gap-0.5 text-[13px]">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 font-medium">{tripLabel}</span>
          <span className="min-w-0 flex-1 truncate">{he.requestSentence.from}{originName} {he.requestSentence.to}{destinationName}</span>
        </span>
        {viaPieces.length > 0 ? <span className="whitespace-normal break-words text-muted-foreground" data-testid="recap-via">{viaPieces.join(" · ")}</span> : null}
        {planBLine ? <span className="whitespace-normal break-words text-muted-foreground" data-testid="recap-plan-b"><LtrText text={planBLine} /></span> : null}
        <span className="whitespace-normal break-words text-muted-foreground" data-testid="recap-when">
          {recapDay} · {windowOn
            ? <LtrText text={tv("requestSentence.window.summary", { hours: windowHoursLabel(windowHours), start: windowStart, end: windowEnd })} />
            : anchored ? <LtrText text={recapPieces.join(" · ")} /> : <span dir="ltr">{plainTimes}</span>}
        </span>
      </span>
    );
    return (
      <StageTwo
        form={form}
        errors={errors}
        rideTypes={rideTypes}
        preferredCars={preferredCars}
        initialPreferredCarName={initialPreferredCarName}
        showRepeatWeekly={!isMultiDay}
        recap={recap}
        notices={notices}
        onBack={() => onStageChange(1)}
      />
    );
  }

  const placeOptions = destinations.map((d) => ({ id: d.id, name: d.name, aliases: d.aliases, zone: d.zone, travelMinutes: d.travel_minutes }));
  // R11U5: the origin is never offered as destination, stop or plan-B place (the origin sheet itself lists everything).
  const originValue = values.origin as DestinationValue | undefined;
  const originPresetId = originValue && "presetId" in originValue ? originValue.presetId : undefined;
  const placesWithoutOrigin = placeOptions.filter((place) => place.id !== originPresetId);
  const carNowHours = values.durationHours ?? CAR_NOW_DEFAULT_HOURS;
  const carNowDurationLabel = carNowHours === 1 ? he.requestSentence.carNowHour : carNowHours === 2 ? he.requestSentence.carNowTwoHours : tv("requestSentence.carNowHours", { n: String(carNowHours) });
  const errorMessages = [errors.destination ? t("request.destinationRequired") : undefined, errors.departTime?.message, errors.returnTime?.message, errors.windowEnd?.message, errors.day?.message].filter(Boolean) as string[];
  const whoChip = (
    <>
      <SentenceChip field="companions" invalid={invalid("companions", "children", "guestNames")} onClick={() => setSheet("who")} data-testid="chip-who">
        <span className="truncate">{whoLabel}</span>
      </SentenceChip>
      <span>{needsVerb}</span>
    </>
  );

  return (
    <div className="space-y-2" data-testid="sentence-layout">
      {hintVisible ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground" data-testid="sentence-hint">
          <span>{he.requestSentence.hint}</span>
          <button type="button" className="relative shrink-0 font-medium text-primary before:absolute before:-inset-2 before:content-['']" onClick={() => { dismissHint(); setHintVisible(false); }}>
            {he.requestSentence.hintDismiss}
          </button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-base leading-8" data-testid="request-sentence">
        {whoChip}
        {variant === "carNow" ? (
          <>
            <Seg prefix={hasDestination ? he.requestSentence.to : undefined}>
              <SentenceChip field="destination" invalid={invalid("destination")} onClick={() => setSheet("destination")} data-testid="chip-destination">
                {destinationName}
              </SentenceChip>
            </Seg>
            <Seg prefix={he.requestSentence.to}>
              <SentenceChip field="durationHours" onClick={() => setSheet("duration")} data-testid="chip-duration">{carNowDurationLabel}</SentenceChip>
            </Seg>
          </>
        ) : (
          <>
            <SentenceChip field="tripType" invalid={invalid("tripType", "tripShape")} onClick={() => setSheet("trip")} data-testid="chip-trip">{tripLabel}</SentenceChip>
            <Seg prefix={he.requestSentence.from}>
              <SentenceChip field="origin" invalid={invalid("origin")} onClick={() => setSheet("origin")} data-testid="chip-origin">{originName}</SentenceChip>
            </Seg>
            <Seg prefix={hasDestination ? he.requestSentence.to : undefined}>
              <SentenceChip field="destination" invalid={invalid("destination")} onClick={() => setSheet("destination")} data-testid="chip-destination">
                {destinationName}
              </SentenceChip>
            </Seg>
            {outStops.map((stop, index) => (
              <Seg key={`${index}:${"presetId" in stop ? stop.presetId : stop.freeText}`} prefix={he.requestSentence.via} spaced>
                <SentenceChip field="outStops" aria-label={`${he.request.removeStop}: ${placeLabel(stop, destinations)}`} onClick={() => removeStop(index)}>
                  {placeLabel(stop, destinations)} ×
                </SentenceChip>
              </Seg>
            ))}
            {isWeekly ? (
              <Seg prefix={he.requestSentence.on}>
                <SentenceChip field="day" invalid={invalid("day", "returnDay")} onClick={() => setSheet("day")} data-testid="chip-day">{dayText}</SentenceChip>
              </Seg>
            ) : null}
            {windowOn ? (
              <>
                <Seg prefix={he.requestSentence.window.forPrefix} loose>
                  <SentenceChip field="windowHours" invalid={invalid("windowHours")} onClick={() => { setMoreWindowHours(windowHours > 6); setSheet("windowHours"); }} data-testid="chip-window-hours">
                    {windowHoursLabel(windowHours)}
                  </SentenceChip>
                </Seg>
                <span>{he.requestSentence.window.between}</span>
                <Seg>
                  <SentenceChip field="windowStart" invalid={invalid("windowStart")} onClick={() => setSheet("windowStart")} data-testid="chip-window-start">
                    <span dir="ltr">{windowStart}</span>
                  </SentenceChip>
                </Seg>
                <Seg prefix={he.requestSentence.window.forPrefix} loose>
                  <SentenceChip field="windowEnd" invalid={invalid("windowEnd")} onClick={() => setSheet("windowEnd")} data-testid="chip-window-end">
                    <span dir="ltr">{windowEnd}</span>
                  </SentenceChip>
                </Seg>
              </>
            ) : (
              <>
                {hasOut ? <Seg>{timeChip("out")}</Seg> : null}
                {hasReturn ? <Seg prefix={hasOut && isPickup ? he.requestSentence.and : undefined}>{timeChip("return")}</Seg> : null}
              </>
            )}
            {hasReturn
              ? returnStops.map((stop, index) => (
                  <Seg key={`r${index}:${"presetId" in stop ? stop.presetId : stop.freeText}`} prefix={he.requestSentence.via} spaced>
                    <SentenceChip field="returnStops" aria-label={`${he.request.removeStop}: ${placeLabel(stop, destinations)}`} onClick={() => removeReturnStop(index)} data-testid="chip-return-stop">
                      {placeLabel(stop, destinations)} ×
                    </SentenceChip>
                  </Seg>
                ))
              : null}
          </>
        )}
      </div>

      {variant === "carNow" ? (
        <div className="space-y-1.5">
          {/* Stays mounted (renders nothing) so RequestForm's render-time `returnTime` write reaches `useWatch`. */}
          <Controller control={control} name="returnTime" render={() => <></>} />
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={he.requestSentence.carNowDuration}>
            {CAR_NOW_QUICK_HOURS.map((hours) => (
              <PillChip key={hours} pressed={carNowHours === hours} onClick={() => form.setValue("durationHours", hours, { shouldDirty: true })}>
                {hours === 1 ? he.requestSentence.carNowHour : hours === 2 ? he.requestSentence.carNowTwoHours : tv("requestSentence.carNowHours", { n: String(hours) })}
              </PillChip>
            ))}
            <PillChip dashed onClick={() => setSheet("duration")}>{he.requestSentence.carNowMore}</PillChip>
          </div>
          <p className="text-xs text-muted-foreground" data-testid="car-now-return">
            <LtrText text={tv("requestSentence.carNowReturnBy", { time: values.returnTime ?? "" })} />
          </p>
        </div>
      ) : null}

      {errorMessages.map((message) => <FieldError key={message} message={message} />)}
      <FieldError message={typeof errors.outStops?.message === "string" ? errors.outStops.message : undefined} />

      {variant !== "carNow" ? (
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="relative shrink-0 text-sm text-primary before:absolute before:-inset-2 before:content-[''] hover:underline"
            onClick={() => setSheet("stop")}
            data-testid="add-stop"
          >
            {he.request.addStop}
          </button>
          {windowOn ? (
            <button
              type="button"
              className="relative shrink-0 text-sm text-primary before:absolute before:-inset-2 before:content-[''] hover:underline"
              onClick={() => setSheet("returnStop")}
              data-testid="add-return-stop-link"
            >
              {he.request.addReturnStop}
            </button>
          ) : null}
          {canWindow ? (
            <button
              type="button"
              className="relative shrink-0 text-sm text-primary before:absolute before:-inset-2 before:content-[''] hover:underline"
              onClick={windowOn ? leaveWindowMode : enterWindowMode}
              data-testid="window-link"
            >
              {windowOn ? he.requestSentence.window.backToFixed : he.requestSentence.window.link}
            </button>
          ) : null}
        </div>
      ) : null}
      {/* R11U10: its own full-width rows (one estimate per row, two at most) instead of a squeezed cell next to the links. */}
      {variant !== "carNow" && derivedLines.length > 0 ? (
        <div className="space-y-0.5 text-xs text-muted-foreground" data-testid="derived-line">
          {derivedLines.map((line) => <p key={line}><LtrText text={line} /></p>)}
        </div>
      ) : null}

      {isWeekly ? <PlanBLine form={form} errors={errors} destinations={destinations} originPlaceId={originPresetId} sheet={sheet} setSheet={setSheet} routeMinutes={routeMinutes.planB} rush={rush} /> : null}

      {notices}

      {isWeekly ? (
        <div className="space-y-1.5" data-testid="stage-one-notes">
          <DetailRow
            label={he.requestSentence.description}
            value={textOrDash(values.rideDescription)}
            open={descriptionOpen}
            onToggle={() => setDescriptionOpen(!descriptionOpen)}
            testId="row-description"
          >
            <FormItem data-field="rideDescription">
              <Controller control={control} name="rideDescription" render={({ field }) => <Textarea {...field} id="request-description" rows={2} maxLength={1000} aria-label={he.requestSentence.description} />} />
              <p className="text-xs text-muted-foreground">{t("quickRequest.rideDescriptionHelp")}</p>
              <FieldError message={errors.rideDescription?.message} />
            </FormItem>
          </DetailRow>
          <DetailRow
            label={he.requestSentence.note}
            value={textOrDash(values.notes)}
            open={notesOpen}
            onToggle={() => setNotesOpen(!notesOpen)}
            testId="row-notes"
          >
            <FormItem data-field="notes">
              <Controller control={control} name="notes" render={({ field }) => <Textarea {...field} id="request-notes" rows={2} aria-label={he.requestSentence.note} />} />
            </FormItem>
          </DetailRow>
        </div>
      ) : null}

      {variant === "quick" ? (
        <>
          <QuickTimeHints isQuickContext={isQuickContext} tripShape={tripShape} oneWay={quickWindow.oneWay} startMs={quickWindow.startMs} endMs={quickWindow.endMs} />
          <QuickFreeCarWarning form={form} isQuickContext={isQuickContext} carIsFree={quickWindow.carIsFree} isAway={quickWindow.isAway} otherFreeCar={quickWindow.otherFreeCar} />
          {seeksDriver ? <p className="text-sm text-destructive">{t("quickRequest.oneWayHelp")}</p> : null}
          <FlexibilityRow
            early={values.flexDepartEarly ?? 0}
            late={values.flexDepartLate ?? 0}
            dataField="flexDepartEarly"
            onChange={setFlexBoth}
          />
        </>
      ) : null}

      {variant !== "weekly" && quickContext ? (
        <CarPreferenceFields
          control={control}
          variant="quick"
          preferredCars={preferredCars}
          initialPreferredCarName={initialPreferredCarName}
          quickContext={quickContext}
        />
      ) : null}

      {variant === "quick" ? (
        <div className="space-y-2">
          <DetailRow
            label={he.requestSentence.description}
            value={textOrDash(values.rideDescription)}
            open={descriptionOpen}
            onToggle={() => setDescriptionOpen(!descriptionOpen)}
            testId="row-description"
          >
            <FormItem data-field="rideDescription">
              <Controller control={control} name="rideDescription" render={({ field }) => <Textarea {...field} id="request-description" rows={2} maxLength={1000} aria-label={he.requestSentence.description} />} />
              <p className="text-xs text-muted-foreground">{t("quickRequest.rideDescriptionHelp")}</p>
              <FieldError message={errors.rideDescription?.message} />
            </FormItem>
          </DetailRow>
          <FormItem className="space-y-1" data-field="rideTypeId">
            <Label className="text-sm">{t("field.rideType")}</Label>
            <Controller
              control={control}
              name="rideTypeId"
              render={({ field }) => (
                <RideTypeChips dots types={rideTypes.map((type) => ({ id: type.id, nameHe: type.name_he, code: type.code }))} value={field.value} onChange={field.onChange} />
              )}
            />
            <FieldError message={errors.rideTypeId?.message} />
          </FormItem>
        </div>
      ) : null}

      <FieldSheet open={sheet === "who"} onOpenChange={(open) => !open && setSheet(null)} title={he.requestSentence.sheet.who} testId="who-dialog">
        <WhoSheet
          form={form}
          members={members}
          childOptions={childOptions}
          recentCompanionIds={recentCompanionIds}
          companions={companionIds}
          children={childIds}
          guestNames={values.guestNames ?? ""}
          extraAdults={extraAdults}
          unnamedChildSeats={unnamedChildSeats}
          boosters={unnamedBoosters}
          guestNamesError={errors.guestNames?.message}
          onChildAdded={mode === "new" ? onChildAdded : undefined}
        />
      </FieldSheet>

      <FieldSheet open={sheet === "trip"} onOpenChange={(open) => !open && setSheet(null)} title={he.requestSentence.sheet.trip}>
        <TripTypeFields control={control} form={form} variant={variant} tripType={tripType} dropOffPickup={dropOffPickup} canDrive={canDrive} pill departmentId={departmentId} destinations={destinations} />
      </FieldSheet>

      <FieldSheet open={sheet === "origin"} onOpenChange={(open) => !open && setSheet(null)} title={he.requestSentence.sheet.origin} hideFooter>
        <PlacePicker
          places={placeOptions}
          value={(values.origin as DestinationValue | undefined) ?? null}
          onPick={(next) => pickPlace("origin", next)}
          placeholder={he.requestSentence.placeSearch}
        />
      </FieldSheet>

      <FieldSheet open={sheet === "destination"} onOpenChange={(open) => !open && setSheet(null)} title={he.requestSentence.sheet.destination} hideFooter>
        <PlacePicker
          places={placesWithoutOrigin}
          value={hasDestination ? (destinationValue as DestinationValue) : null}
          onPick={(next) => pickPlace("destination", next)}
          placeholder={he.requestSentence.placeSearch}
          recent={recentDestinations}
        />
      </FieldSheet>

      <FieldSheet open={sheet === "stop"} onOpenChange={(open) => !open && setSheet(null)} title={he.requestSentence.sheet.stop} hideFooter>
        <PlacePicker places={placesWithoutOrigin} value={null} onPick={addStop} placeholder={he.requestSentence.placeSearch} />
      </FieldSheet>

      <FieldSheet open={sheet === "returnStop"} onOpenChange={(open) => !open && setSheet(null)} title={he.requestSentence.sheet.returnStop} hideFooter>
        <PlacePicker places={placesWithoutOrigin} value={null} onPick={addReturnStop} placeholder={he.requestSentence.placeSearch} />
      </FieldSheet>

      <FieldSheet open={sheet === "day"} onOpenChange={(open) => !open && setSheet(null)} title={he.requestSentence.sheet.day}>
        <DayAndTripShapeFields
          control={control}
          form={form}
          weekStart={weekStart}
          variant={variant}
          showReturnDayPicker={showReturnDayPicker}
          returnAnotherDay={returnAnotherDay}
          setReturnAnotherDay={setReturnAnotherDay}
          day={day}
          isMultiDay={isMultiDay}
          multiDaySpan={multiDaySpan}
          isQuickContext={isQuickContext}
          seeksDriver={seeksDriver}
          tripType={tripType}
          dropOffPickup={dropOffPickup}
          canDrive={canDrive}
          showTripType={false}
        />
      </FieldSheet>

      <FieldSheet
        open={sheet === "out"}
        onOpenChange={(open) => !open && setSheet(null)}
        title={he.requestSentence.sheet.outTime}
      >
        <TimeAnchorSheet
          form={form}
          end="out"
          isPickup={false}
          routeMinutes={routeMinutes.out}
          rush={rush}
          anchorsEnabled={anchorsEnabled}
          flexEnabled={flexEnabled}
          stopsEnabled={false}
          returnStops={[]}
          timeError={errors.departTime?.message}
        />
      </FieldSheet>

      <FieldSheet
        open={sheet === "return"}
        onOpenChange={(open) => !open && setSheet(null)}
        title={isPickup ? he.requestSentence.sheet.pickupTime : he.requestSentence.sheet.returnTime}
      >
        <TimeAnchorSheet
          form={form}
          end="return"
          isPickup={isPickup}
          routeMinutes={routeMinutes.return}
          rush={rush}
          anchorsEnabled={anchorsEnabled}
          flexEnabled={flexEnabled}
          stopsEnabled={variant !== "carNow"}
          returnStops={returnStops.map((stop) => placeLabel(stop, destinations))}
          onAddReturnStop={() => setSheet("returnStop")}
          onRemoveReturnStop={removeReturnStop}
          timeError={errors.returnTime?.message}
          stopsError={typeof errors.returnStops?.message === "string" ? errors.returnStops.message : undefined}
        />
      </FieldSheet>

      <FieldSheet open={sheet === "windowHours"} onOpenChange={(open) => !open && setSheet(null)} title={he.requestSentence.window.hoursTitle} testId="window-hours-sheet">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={he.requestSentence.window.hoursTitle} data-field="windowHours">
          {[...WINDOW_QUICK_HOURS, ...(moreWindowHours || windowHours > 6 ? Array.from({ length: WINDOW_MAX_HOURS - 6 }, (_, i) => i + 7) : [])].map((hours) => (
            <PillChip key={hours} pressed={windowHours === hours} onClick={() => changeWindow({ windowHours: hours })} data-testid={`window-hours-${hours}`}>
              {windowHoursLabel(hours)}
            </PillChip>
          ))}
          {moreWindowHours || windowHours > 6 ? null : (
            <PillChip dashed onClick={() => setMoreWindowHours(true)} data-testid="window-hours-more">{he.requestSentence.window.more}</PillChip>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{tv("requestSentence.window.hint", { hours: windowHoursLabel(windowHours) })}</p>
        <FieldError message={errors.windowEnd?.message} />
      </FieldSheet>

      <FieldSheet open={sheet === "windowStart"} onOpenChange={(open) => !open && setSheet(null)} title={he.requestSentence.window.startTitle} testId="window-start-sheet">
        <div className="flex justify-center" data-field="windowStart">
          <TimeField15 min={WINDOW_EARLIEST_START} max={WINDOW_LATEST_END} value={windowStart} onChange={(next) => changeWindow({ windowStart: next })} aria-label={he.requestSentence.window.startAria} />
        </div>
        <FieldError message={errors.windowEnd?.message} />
      </FieldSheet>

      <FieldSheet open={sheet === "windowEnd"} onOpenChange={(open) => !open && setSheet(null)} title={he.requestSentence.window.endTitle} testId="window-end-sheet">
        <div className="flex justify-center" data-field="windowEnd">
          <TimeField15 min={WINDOW_EARLIEST_START} max={WINDOW_LATEST_END} value={windowEnd} onChange={(next) => form.setValue("windowEnd", next, { shouldDirty: true, shouldValidate: true })} aria-label={he.requestSentence.window.endAria} />
        </div>
        <FieldError message={errors.windowEnd?.message} />
      </FieldSheet>

      <FieldSheet open={sheet === "duration"} onOpenChange={(open) => !open && setSheet(null)} title={he.requestSentence.sheet.duration}>
        <CarPreferenceFields control={control} variant="carNow" preferredCars={[]} initialPreferredCarName={undefined} quickContext={{ cars: [], showCarPicker: false }} />
      </FieldSheet>
    </div>
  );
}
