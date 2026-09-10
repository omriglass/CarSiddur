import { zodResolver } from "@hookform/resolvers/zod";
import { format, getDay, parseISO } from "date-fns";
import { useContext, useMemo, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { SheetPortalContext } from "@/components/SheetPortalContext";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { FormItem } from "@/components/ui/form";
import { CarAtDestinationToggle } from "@/components/CarAtDestinationToggle";
import { CompanionPicker } from "@/components/CompanionPicker";
import { DateField, datesOfWeek } from "@/components/DateField";
import { DestinationCombobox, type DestinationValue } from "@/components/DestinationCombobox";
import { FlexibilityRange } from "@/components/FlexibilitySegmented";
import { OneWayCarModeControl } from "@/components/OneWayCarModeControl";
import { RideTypeChips } from "@/components/RideTypeChips";
import { TimeField15 } from "@/components/TimeField15";
import { TripShapeControl } from "@/components/TripShapeControl";
import { useDepartmentMembers } from "@/features/auth/useDepartmentMembers";
import { useSession } from "@/features/auth/useSession";
import { useCars, useCarSeatConfigs, useDestinations, useRideTypes, useSuggestDestinationMutation } from "@/features/fleet/hooks";
import { useDepartmentSettings, useWeekRow } from "@/features/sadran/hooks";
import { isSlotFree, type CarFreeWindow } from "@/features/siddur/freeWindows";
import { siddurKeys } from "@/features/siddur/queryKeys";
import { he, t, tv } from "@/i18n/he";
import { dateKey, formatTime, weekdayIndex } from "@/lib/time";
import { cn } from "@/lib/utils";
import { fits, type Car as SolverCar } from "@/solver";

import type { RequestEditRow, SubmitRequestResult, TemplateSuggestion } from "../api";
import { CAR_NOW_DEFAULT_HOURS, CAR_NOW_HOURS_OPTIONS } from "../carNow";
import { findOverlappingRequest } from "../duplicate";
import { QUICK_REQUEST_DURATION_HOURS, endTimeForDuration, shiftReturnByDepartureDelta } from "../duration";
import { guestPassengerNames, quickVehicleWindow } from "../quickRequest";
import {
  useMyRequests,
  useRequestCompanionsQuery,
  useSaveRequestTemplateMutation,
  useSetRequestCompanionsMutation,
  useSetRequestChildrenMutation,
  useRequestChildrenQuery,
  useStopTemplateMutation,
  useSubmitRequestMutation,
} from "../hooks";
import { fetchChildren } from "../children";
import { intervalToFlexValue, toInstant, toSubmitRequestPayload } from "../mapper";
import { requestFormSchema, type RequestFormValues } from "../schema";
import { toastSubmitOutcome } from "../submitOutcome";
import { suggestionToFormValues } from "../templatePrefill";

export interface JoinRidePrefill {
  rideId: string;
  driverName: string;
  carType: "shared" | "temporary";
  isRelay: boolean;
  destinationId: string | null;
  destinationName: string;
  startsAt: string;
  endsAt: string;
}

export interface QuickRequestCarOption {
  id: string;
  name: string;
  type: "shared" | "temporary";
}

export interface QuickRequestAwayWindow {
  carId: string;
  awayFrom: string;
  awayUntil: string | null;
}

export interface QuickRequestContext {
  /** Every shared car in the department, for the "another car is free" offer and the optional picker. */
  cars: readonly QuickRequestCarOption[];
  /** Pre-computed per-car free windows for `day`'s displayed range (`features/siddur/freeWindows.ts`). */
  freeWindows: readonly CarFreeWindow[];
  /** Raw away-from-home windows, for the more specific "away" warning (a subset of what's already excluded from `freeWindows`). */
  awayWindows?: readonly QuickRequestAwayWindow[];
  /** Phone "לוקח/ת רכב עכשיו" flow: lets the member change which car they're asking for. */
  showCarPicker?: boolean;
  now: Date;
}

interface RequestFormProps {
  mode: "new" | "edit";
  /**
   * "weekly" (default) is the full new/edit request form (UX_FLOWS.md §3.4). "quick" is the
   * empty-grid-slot quick request on an Open/Solving/Published/live siddur day (§18) — the
   * same fields, form and submit path, just pre-filled to a slot's day/time/car and with the
   * free-window-aware car picker/hint (`quickContext`) turned on. "carNow" is the simplified
   * always-about-today "רוצה רכב עכשיו!" flow (`CarNowButton`, Home §3.3): day/depart are
   * preset and hidden (today, now rounded up to the next 15 minutes), there is no day picker,
   * trip-shape, flexibility or return-time field, and a `durationHours` select (1–12h,
   * `../carNow.ts`) drives the return time instead. Every field lives in exactly one
   * component, so a field added to one variant automatically appears in the others.
   */
  variant?: "weekly" | "quick" | "carNow";
  departmentId: string;
  weekStart: string;
  /** Edit mode only. */
  initial?: RequestEditRow;
  /** "Ask to join" prefill from `/requests/new?ride=<id>` (UX_FLOWS §3.4/§3.5). */
  joinRide?: JoinRidePrefill;
  /**
   * Day/time (and, for the quick variant, car) prefill: on an Open/Solving-week siddur
   * (UX_FLOWS.md §18) only the day and start time carry over from an empty grid cell click
   * (no car — the Sadran hasn't solved yet); the quick variant additionally pins a car and,
   * when `returnTime` is omitted, defaults it to `departTime` + `QUICK_REQUEST_DURATION_HOURS`.
   */
  slotPrefill?: { day: string; departTime: string; returnTime?: string; carId?: string };
  /** Published-day request: join the freed-slot notification queue. */
  waitlist?: boolean;
  /**
   * Repeating-request-suggestion prefill (`/requests/new?template=<id>`, UX_FLOWS §3.3/§3.4,
   * REQ §76) — weekly variant only, mutually exclusive with `joinRide`/`slotPrefill` in
   * practice. Pre-checks the "repeat weekly" switch; submitting links the new request straight
   * to this template (`SubmitRequestPayload.template_id`) so the suggestion disappears.
   */
  templateSuggestion?: TemplateSuggestion;
  /** Quick-variant-only context — free-window aware car targeting (UX_FLOWS.md §18). */
  quickContext?: QuickRequestContext;
  /** Called after a successful submit instead of the default `navigate('/requests')`. */
  onDone?: (result: SubmitRequestResult | null) => void;
}

function dayFromInstant(instant: string): string {
  return dateKey(instant);
}
function timeFromInstant(instant: string): string {
  return formatTime(new Date(instant));
}
function dayLabel(dateStr: string): string {
  const parsed = parseISO(dateStr);
  return `${he.days.short[getDay(parsed)]} ${format(parsed, "dd.MM")}`;
}

function buildDefaultDay(weekStart: string, lastDepartAt: string | null | undefined): string {
  if (!lastDepartAt) return weekStart; // datesOfWeek(weekStart)[0] === weekStart (the Sunday itself)
  const dates = datesOfWeek(weekStart);
  const weekday = weekdayIndex(lastDepartAt); // 0=Sun..6=Sat, matches datesOfWeek order
  return dates[weekday] ?? weekStart;
}

function emptyValues(
  departmentId: string,
  weekStart: string,
  day: string,
  rideTypeId: string,
  departTime = "08:00",
  returnTime = "12:00",
  preferredCarId = "",
  durationHours?: number,
): RequestFormValues {
  const dates = datesOfWeek(weekStart);
  return {
    departmentId,
    weekStart,
    day,
    dayIndex: Math.max(dates.indexOf(day), 0),
    destination: { freeText: "" },
    rideTypeId,
    preferredCarId,
    tripShape: "round_trip",
    departTime,
    returnTime,
    returnNextDay: false,
    oneWayCarMode: undefined,
    needsCarAtDestination: true,
    adults: 1,
    childSeats: 0,
    boosters: 0,
    companions: [],
    children: [],
    legacyChildSeats: 0,
    luggage: false,
    flexDepartEarly: 0,
    flexDepartLate: 0,
    flexReturnEarly: 0,
    flexReturnLate: 0,
    notes: "",
    rideDescription: "",
    guestNames: "",
    durationHours,
    repeatWeekly: false,
  };
}

function buildJoinRideValues(
  departmentId: string,
  weekStart: string,
  rideTypeId: string,
  joinRide: JoinRidePrefill,
): RequestFormValues {
  const base = emptyValues(departmentId, weekStart, dayFromInstant(joinRide.startsAt), rideTypeId);
  return {
    ...base,
    destination: joinRide.destinationId
      ? { presetId: joinRide.destinationId, name: joinRide.destinationName }
      : { freeText: joinRide.destinationName },
    tripShape: joinRide.isRelay ? "one_way_to" : "round_trip",
    departTime: timeFromInstant(joinRide.startsAt),
    returnTime: joinRide.isRelay ? undefined : timeFromInstant(joinRide.endsAt),
    oneWayCarMode: joinRide.isRelay ? "passenger" : undefined,
    needsCarAtDestination: !joinRide.isRelay,
  };
}

function mapEditRowToValues(row: RequestEditRow, weekStart: string, companions: string[], children: string[]): RequestFormValues {
  const day = row.departAt ? dayFromInstant(row.departAt) : row.returnAt ? dayFromInstant(row.returnAt) : weekStart;
  const dates = datesOfWeek(weekStart);
  const departTime = row.departAt ? timeFromInstant(row.departAt) : undefined;
  const returnTime = row.returnAt ? timeFromInstant(row.returnAt) : undefined;
  const returnNextDay = !!(
    row.departAt &&
    row.returnAt &&
    dayFromInstant(row.returnAt) !== dayFromInstant(row.departAt)
  );

  return {
    departmentId: row.departmentId,
    weekStart,
    day,
    dayIndex: Math.max(dates.indexOf(day), 0),
    destination: row.destinationId
      ? { presetId: row.destinationId, name: row.destinationName ?? "" }
      : { freeText: row.destinationText ?? "" },
    rideTypeId: row.rideTypeId,
    preferredCarId: row.preferredCarId ?? "",
    tripShape: row.tripShape,
    departTime,
    returnTime: returnNextDay ? "23:59" : returnTime,
    returnNextDay: false,
    oneWayCarMode: (row.oneWayCarMode ?? undefined) as "relay" | "passenger" | undefined,
    needsCarAtDestination: row.needsCarAtDestination,
    adults: row.adults,
    childSeats: children.length,
    legacyChildSeats: children.length ? 0 : row.childSeats,
    boosters: row.boosters,
    companions,
    children,
    luggage: row.hasLuggage,
    flexDepartEarly: intervalToFlexValue(row.flexDepartEarly),
    flexDepartLate: intervalToFlexValue(row.flexDepartLate),
    flexReturnEarly: intervalToFlexValue(row.flexReturnEarly),
    flexReturnLate: intervalToFlexValue(row.flexReturnLate),
    notes: row.notes ?? "",
    rideDescription: row.rideDescription ?? "",
    guestNames: (row.guestPassengerNames ?? []).join("\n"),
    repeatWeekly: !!row.templateId,
  };
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p role="alert" className="text-sm font-medium text-destructive">{message}</p>;
}

/**
 * New/edit request form (UX_FLOWS.md §3.4/§18, component inventory `RequestForm`). One form
 * body for both the full weekly request and the live-week "quick" request (`variant` prop) —
 * sticky footer, smart defaults, non-blocking seat-fit and duplicate warnings, submits via
 * `submit_request` (CLAUDE.md decision 8).
 */
export function RequestForm({
  mode,
  variant = "weekly",
  departmentId,
  weekStart,
  initial,
  joinRide,
  slotPrefill,
  waitlist = false,
  templateSuggestion,
  quickContext,
  onDone,
}: RequestFormProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const destinationsQuery = useDestinations(departmentId);
  const rideTypesQuery = useRideTypes(departmentId);
  const carsQuery = useCars(departmentId);
  const seatConfigsQuery = useCarSeatConfigs(departmentId);
  const myRequestsQuery = useMyRequests();
  const membersQuery = useDepartmentMembers(departmentId);
  const { session } = useSession();
  const companionsQuery = useRequestCompanionsQuery(initial?.id);
  const requestChildrenQuery = useRequestChildrenQuery(initial?.id);
  const settingsQuery = useDepartmentSettings(departmentId);
  const weekRowQuery = useWeekRow(departmentId, weekStart);

  const submitMutation = useSubmitRequestMutation();
  const setCompanionsMutation = useSetRequestCompanionsMutation();
  const setChildrenMutation = useSetRequestChildrenMutation();
  const suggestDestinationMutation = useSuggestDestinationMutation(departmentId);
  const saveTemplateMutation = useSaveRequestTemplateMutation();
  const stopTemplateMutation = useStopTemplateMutation();

  const lastRequest = [...(myRequestsQuery.data ?? [])]
    .filter((r) => r.departAt)
    .sort((a, b) => new Date(b.departAt as string).getTime() - new Date(a.departAt as string).getTime())[0];
  const defaultRideTypeId = rideTypesQuery.data?.find((type) => type.code === "other")?.id ?? rideTypesQuery.data?.[0]?.id ?? "";

  const defaultValues = useMemo(() => {
    if (mode === "edit") return emptyValues(departmentId, weekStart, weekStart, defaultRideTypeId);
    if (joinRide) return buildJoinRideValues(departmentId, weekStart, defaultRideTypeId, joinRide);
    if (templateSuggestion) return suggestionToFormValues(templateSuggestion, weekStart);
    if (slotPrefill) {
      const returnTime =
        slotPrefill.returnTime ??
        (variant === "quick"
          ? endTimeForDuration(slotPrefill.departTime, QUICK_REQUEST_DURATION_HOURS).time
          : variant === "carNow"
            ? endTimeForDuration(slotPrefill.departTime, CAR_NOW_DEFAULT_HOURS).time
            : undefined);
      return emptyValues(
        departmentId,
        weekStart,
        slotPrefill.day,
        defaultRideTypeId,
        slotPrefill.departTime,
        returnTime,
        slotPrefill.carId ?? "",
        variant === "carNow" ? CAR_NOW_DEFAULT_HOURS : undefined,
      );
    }
    return emptyValues(
      departmentId,
      weekStart,
      buildDefaultDay(weekStart, lastRequest?.departAt),
      defaultRideTypeId,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departmentId, weekStart, mode, defaultRideTypeId, variant, joinRide?.rideId, templateSuggestion?.templateId, slotPrefill?.day, slotPrefill?.departTime, slotPrefill?.returnTime, slotPrefill?.carId]);

  const form = useForm<RequestFormValues>({
    resolver: zodResolver(requestFormSchema),
    defaultValues,
    mode: "onBlur",
  });

  // The catalog may arrive after useForm captures its initial defaults.
  if (mode !== "edit" && defaultRideTypeId && !form.getValues("rideTypeId")) {
    form.setValue("rideTypeId", defaultRideTypeId);
  }

  // Resets the form once the edit-mode data (`initial` + companions) arrives. Done
  // synchronously during render — the same "remembered previous value" idiom
  // `TimeField15` uses — rather than in a `useEffect`, per this codebase's
  // `react-hooks/set-state-in-effect` lint rule (calling `setState` inside an effect
  // body is flagged; adjusting state for freshly-arrived props during render is not).
  const [resetKey, setResetKey] = useState<string | null>(null);
  // Set only by `PortalSheetContent`/`PortalDialogContent` (`QuickRequestSheet`'s host) — reused
  // here to tell the fixed submit bar it has no app tab bar to clear (SheetPortalContext.ts).
  const insideModalSheet = useContext(SheetPortalContext) !== null;
  if (mode === "edit" && initial && companionsQuery.isSuccess && requestChildrenQuery.isSuccess) {
    const nextResetKey = `${initial.id}:${initial.version}`;
    if (nextResetKey !== resetKey) {
      form.reset(mapEditRowToValues(initial, weekStart, companionsQuery.data, requestChildrenQuery.data));
      setResetKey(nextResetKey);
    }
  }
  const hasResetForEdit = mode !== "edit" || resetKey !== null;

  const values = useWatch({ control: form.control });
  const tripShape = values.tripShape ?? "round_trip";
  const oneWay = tripShape !== "round_trip";
  // Quick one-way requests are always "reserve the car, look for a volunteer driver"
  // (UX_FLOWS.md §18) — unlike the weekly form there is no relay-vs-passenger choice to make.
  // `oneWayCarMode`'s own `Controller` (`OneWayCarModeControl` below) only mounts when
  // `!quickContext`, so it is never a registered field in the quick variant — `useWatch`'s
  // all-fields snapshot (`values`) only reflects *registered* fields and would permanently
  // read `undefined` here regardless of `setValue`, turning this render-phase sync into an
  // infinite loop (every render re-observes the stale `undefined` and calls `setValue` again).
  // `form.getValues` reads the authoritative store directly, so it converges after one call.
  if (quickContext && oneWay && form.getValues("oneWayCarMode") !== "passenger") {
    form.setValue("oneWayCarMode", "passenger", { shouldValidate: true });
  }
  // carNow has no return-time picker — `returnTime` tracks the fixed (preset, hidden)
  // `departTime` plus the visible `durationHours` select instead. Its own `Controller` below
  // stays mounted (rendering `null`) specifically so this write reaches `useWatch`'s `values`
  // snapshot, used by the free-car/duplicate checks further down — see the `oneWayCarMode`
  // comment above for why an unmounted `Controller` would freeze it at a stale value instead.
  if (variant === "carNow" && values.departTime) {
    const computedReturn = endTimeForDuration(values.departTime, values.durationHours ?? CAR_NOW_DEFAULT_HOURS).time;
    if (form.getValues("returnTime") !== computedReturn) {
      form.setValue("returnTime", computedReturn, { shouldValidate: true });
    }
  }
  const day = values.day ?? weekStart;
  const childReferenceYear = Number(day.slice(0, 4));
  const childrenQuery = useQuery({ queryKey: ["children", departmentId, session?.user.id, childReferenceYear], queryFn: () => fetchChildren(departmentId, session!.user.id, childReferenceYear), enabled: !!session?.user.id });
  const guests = guestPassengerNames(values.guestNames ?? "");
  // The requester is always one adult; every selected member, named child aged eight or
  // older and guest name is another. Named children below eight use a child seat instead.
  const selectedChildren = (childrenQuery.data ?? []).filter((child) => values.children?.includes(child.id));
  const namedAdultCount = 1 + (values.companions?.length ?? 0) + selectedChildren.filter((child) => child.isAdultPassenger).length + guests.length;
  const selectedChildSeatCount = selectedChildren.filter((child) => !child.isAdultPassenger).length;
  const namedChildCount = Math.max(selectedChildSeatCount, values.legacyChildSeats ?? 0);
  const preferredCars = (carsQuery.data ?? []).filter((car) => car.type === "shared" && car.status === "active");

  const seatFitWarning = useMemo(() => {
    if (!carsQuery.data || !seatConfigsQuery.data) return false;
    const passengers = {
      adults: namedAdultCount,
      childSeats: namedChildCount,
      boosters: values.boosters ?? 0,
    };
    const cars: SolverCar[] = carsQuery.data
      .filter((c) => c.status === "active")
      .map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        seatConfigs: (seatConfigsQuery.data ?? [])
          .filter((sc) => sc.car_id === c.id)
          .map((sc) => ({ adults: sc.adults, childSeats: sc.child_seats, boosters: sc.boosters })),
        features: c.features,
        luggageCapacity: c.features.includes("large_trunk") ? 2 : 1,
        maintenance: [],
      }));
    return cars.length > 0 && !cars.some((c) => fits(c, passengers));
  }, [carsQuery.data, seatConfigsQuery.data, namedAdultCount, namedChildCount, values.boosters]);

  const duplicate = useMemo(() => {
    if (!values.departTime && !values.returnTime) return null;
    const departAt =
      tripShape !== "one_way_from" && values.departTime ? toInstant(day, values.departTime, false) : null;
    const returnAt =
      tripShape !== "one_way_to" && values.returnTime
        ? toInstant(day, values.returnTime, false)
        : null;
    const candidates = (myRequestsQuery.data ?? []).filter(
      (r) => r.departmentId === departmentId && !["withdrawn", "cancelled", "denied"].includes(r.status),
    );
    return findOverlappingRequest({ departAt, returnAt }, candidates, initial?.id);
  }, [day, tripShape, values.departTime, values.returnTime, myRequestsQuery.data, departmentId, initial?.id]);

  // Quick-variant-only: free-window pre-validation (server RPC remains the sole authority).
  const departTimeSafe = values.departTime || "08:00";
  const returnTimeSafe = values.returnTime || "12:00";
  const primaryTime = tripShape === "one_way_from" ? (values.returnTime ?? "") : (values.departTime ?? "");
  const selectedMs = Date.parse(toInstant(day, tripShape === "one_way_from" ? returnTimeSafe : departTimeSafe, false));
  const roundTripEndMs = Date.parse(toInstant(day, returnTimeSafe, false));
  const destinationId = values.destination && "presetId" in values.destination ? values.destination.presetId : undefined;
  const travelMinutes = destinationsQuery.data?.find((d) => d.id === destinationId)?.travel_minutes ?? 30;
  const overrides = weekRowQuery.data?.settings_overrides;
  const overrideDwell = overrides && typeof overrides === "object" && !Array.isArray(overrides) ? overrides.chauffeur_dwell_minutes : undefined;
  const dwellMinutes = typeof overrideDwell === "number" ? overrideDwell : settingsQuery.data?.chauffeur_dwell_minutes ?? 10;
  const { startMs, endMs } = quickContext
    ? quickVehicleWindow(tripShape, selectedMs, roundTripEndMs, travelMinutes, dwellMinutes)
    : { startMs: 0, endMs: 0 };
  const quickCarId = values.preferredCarId || "";
  const quickCar = quickContext?.cars.find((c) => c.id === quickCarId) ?? null;
  const carIsFree = !quickContext || isSlotFree(quickContext.freeWindows, quickCarId, startMs, endMs);
  const isAway =
    !!quickContext &&
    !carIsFree &&
    (quickContext.awayWindows ?? []).some(
      (w) =>
        w.carId === quickCarId &&
        startMs < (w.awayUntil ? Date.parse(w.awayUntil) : Infinity) &&
        Date.parse(w.awayFrom) < endMs,
    );
  const otherFreeCar =
    quickContext && !carIsFree ? quickContext.cars.find((c) => c.id !== quickCarId && isSlotFree(quickContext.freeWindows, c.id, startMs, endMs)) : undefined;
  const isPast = !!quickContext && selectedMs < quickContext.now.getTime();
  const outsideDay = !!quickContext && (startMs < Date.parse(toInstant(day, "00:00", false)) || endMs > Date.parse(toInstant(day, "23:59", false)));
  const invalidTime = !!quickContext && (endMs <= startMs || outsideDay);

  const [submitError, setSubmitError] = useState<string | null>(null);

  async function onSubmit(formValues: RequestFormValues) {
    if (quickContext && (isPast || invalidTime)) return;
    setSubmitError(null);
    const selected = (childrenQuery.data ?? []).filter((child) => formValues.children.includes(child.id));
    const childAdults = selected.filter((child) => child.isAdultPassenger).length;
    const childSeatsCount = selected.filter((child) => !child.isAdultPassenger).length;
    const guestNamesList = guestPassengerNames(formValues.guestNames);
    const isOneWay = formValues.tripShape !== "round_trip";
    const payload = {
      ...toSubmitRequestPayload(
        {
          ...formValues,
          adults: 1 + formValues.companions.length + childAdults + guestNamesList.length,
          childSeats: Math.max(childSeatsCount, formValues.legacyChildSeats),
        },
        {
          requestId: initial?.id,
          expectedVersion: initial?.version,
          joinRideId: mode === "new" ? joinRide?.rideId : undefined,
          guestPassengerNames: guestNamesList,
          reserveMissingDriver: variant === "quick" && isOneWay ? true : undefined,
        },
      ),
      ...(waitlist ? { waitlist: true } : {}),
      // Only a *new* request can link to an existing template on creation (`submit_request`'s
      // insert branch is the only place it reads `template_id`); an edit's own template link,
      // if any, is managed separately below via save/stop, never touched by this payload.
      ...(mode === "new" && templateSuggestion ? { template_id: templateSuggestion.templateId } : {}),
    };

    // The request this template link/unlink applies to, resolved once so both the "on" and
    // "off" branches below agree: an edit keeps its own row's template, a prefilled new
    // request inherits the suggestion's.
    const existingTemplateId = mode === "edit" ? (initial?.templateId ?? undefined) : templateSuggestion?.templateId;

    try {
      const raw = await submitMutation.mutateAsync(payload);
      const result = raw as unknown as SubmitRequestResult | null;
      const requestId = result?.request_id ?? initial?.id;

      if (requestId) {
        await setCompanionsMutation.mutateAsync({ requestId, profileIds: formValues.companions });
        await setChildrenMutation.mutateAsync({ requestId, childIds: formValues.children });

        // "Repeat weekly" (UX_FLOWS §3.3/§3.4, REQ §76): capture/refresh the template when the
        // switch is on, or stop a template this request was already linked to when it's off.
        // Errors here are non-fatal to the request itself — each mutation's own `onError`
        // already surfaced a toast — so the request submission outcome below is unaffected.
        try {
          if (formValues.repeatWeekly) {
            await saveTemplateMutation.mutateAsync(requestId);
            if (mode === "new") toast.success(t("request.repeatSaved"));
          } else if (existingTemplateId) {
            await stopTemplateMutation.mutateAsync(existingTemplateId);
          }
        } catch { /* already toasted by the mutation itself */ }
      }
      if ("freeText" in formValues.destination && formValues.destination.freeText.trim()) {
        suggestDestinationMutation.mutate({ name: formValues.destination.freeText.trim() });
      }

      if ((variant === "quick" || variant === "carNow") && quickContext) {
        queryClient.invalidateQueries({ queryKey: siddurKeys.boardRides(departmentId, weekStart) });
        queryClient.invalidateQueries({ queryKey: siddurKeys.carLocations(departmentId, weekStart) });
      }

      // One outcome toast for both variants (weekly and quick) — see `toastSubmitOutcome` for
      // why an ordinary weekly submission against an open/solving week stays silent. The quick
      // variant resolves car names against its own `quickContext.cars` (the exact free-window-
      // aware set the picker showed), not the plain `carsQuery` every variant also loads.
      const carLookup = quickContext?.cars ?? carsQuery.data ?? [];
      toastSubmitOutcome(result, {
        carName: (id) => carLookup.find((c) => c.id === id)?.name ?? "",
        preferredCarId: formValues.preferredCarId,
        departTime: formValues.departTime,
        returnTime: formValues.returnTime,
        onViewRequests: () => navigate("/requests"),
      });

      if (onDone) onDone(result);
      else navigate("/requests");
    } catch {
      setSubmitError(variant === "quick" || variant === "carNow" ? t("quickRequest.submitError") : t("request.submitError"));
    }
  }

  const isLoading = destinationsQuery.isLoading || rideTypesQuery.isLoading || !hasResetForEdit;

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        <div className="h-11 animate-pulse rounded-md bg-muted" />
        <div className="h-11 animate-pulse rounded-md bg-muted" />
        <div className="h-11 animate-pulse rounded-md bg-muted" />
      </div>
    );
  }

  return (
    <form
      onSubmit={form.handleSubmit(onSubmit)}
      className={cn("mx-auto flex max-w-2xl flex-col gap-5 p-4", insideModalSheet ? "pb-20" : "pb-28")}
    >
      {quickContext ? (
        <p className="text-base font-semibold">
          {oneWay
            ? tv("quickRequest.oneWayHeader", { day: dayLabel(day), start: primaryTime })
            : quickCar
              ? tv("quickRequest.header", { car: quickCar.name, day: dayLabel(day), start: primaryTime })
              : tv("quickRequest.headerNoCar", { day: dayLabel(day), start: primaryTime })}
        </p>
      ) : null}

      {joinRide ? (
        <div className="rounded-md border-s-4 border-primary bg-primary/5 p-3 text-sm">
          {joinRide.carType === "temporary"
            ? tv("request.joinRideBannerTemp", { driverName: joinRide.driverName })
            : tv("request.joinRideBannerShared", { driverName: joinRide.driverName })}
        </div>
      ) : null}
      {mode === "edit" && initial?.changedSinceSolve ? (
        <div className="rounded-md border-s-4 border-amber-500 bg-amber-50 p-3 text-sm text-amber-900">
          {t("request.changedSinceSolveBanner")}
        </div>
      ) : null}
      {waitlist ? <div className="rounded-md border-s-4 border-amber-500 bg-amber-50 p-3 text-sm text-amber-900">{t("request.waitlistBanner")}</div> : null}

      <FormItem>
        <Label>{t("field.destination")}</Label>
        <Controller
          control={form.control}
          name="destination"
          render={({ field }) => (
            <DestinationCombobox
              destinations={(destinationsQuery.data ?? []).map((d) => ({
                id: d.id,
                name: d.name,
                aliases: d.aliases,
                zone: d.zone,
              }))}
              value={field.value as DestinationValue}
              onChange={field.onChange}
              autoFocus={variant === "quick" || variant === "carNow"}
            />
          )}
        />
        <FieldError message={form.formState.errors.destination ? t("request.destinationRequired") : undefined} />
      </FormItem>

      <FormItem>
        <Label>{t("field.rideType")}</Label>
        <Controller
          control={form.control}
          name="rideTypeId"
          render={({ field }) => (
            <RideTypeChips
              types={(rideTypesQuery.data ?? []).map((rt) => ({ id: rt.id, nameHe: rt.name_he }))}
              value={field.value}
              onChange={field.onChange}
            />
          )}
        />
        <FieldError message={form.formState.errors.rideTypeId?.message} />
      </FormItem>

      {variant === "carNow" ? (
        <FormItem>
          <Label htmlFor="request-duration-hours">{t("quickRequest.durationHours")}</Label>
          <Controller
            control={form.control}
            name="durationHours"
            render={({ field }) => (
              <Select value={String(field.value ?? CAR_NOW_DEFAULT_HOURS)} onValueChange={(value) => field.onChange(Number(value))}>
                <SelectTrigger id="request-duration-hours"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CAR_NOW_HOURS_OPTIONS.map((hours) => (
                    <SelectItem key={hours} value={String(hours)}>
                      {hours === 1 ? he.quickRequest.hoursOptionOne : tv("quickRequest.hoursOption", { n: String(hours) })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </FormItem>
      ) : null}

      {!quickContext ? (
        <FormItem>
          <Label htmlFor="request-preferred-car">{t("request.preferredCar")}</Label>
          <Controller control={form.control} name="preferredCarId" render={({ field }) => (
            <Select value={field.value || "none"} onValueChange={(value) => field.onChange(value === "none" ? "" : value)}>
              <SelectTrigger id="request-preferred-car"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("request.noPreferredCar")}</SelectItem>
                {field.value && !preferredCars.some((car) => car.id === field.value) ? (
                  <SelectItem value={field.value} disabled>{initial?.preferredCarName ?? t("request.preferredCarUnavailable")}</SelectItem>
                ) : null}
                {preferredCars.map((car) => <SelectItem key={car.id} value={car.id}>{car.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )} />
          <p className="text-xs text-muted-foreground">{t("request.preferredCarHelper")}</p>
        </FormItem>
      ) : quickContext.showCarPicker ? (
        <FormItem>
          <Label htmlFor="request-preferred-car">{t("quickRequest.carPickerLabel")}</Label>
          <Controller control={form.control} name="preferredCarId" render={({ field }) => (
            <Select value={field.value || ""} onValueChange={field.onChange}>
              <SelectTrigger id="request-preferred-car"><SelectValue /></SelectTrigger>
              <SelectContent>
                {quickContext.cars.map((car) => <SelectItem key={car.id} value={car.id}>{car.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )} />
        </FormItem>
      ) : null}

      {variant !== "carNow" ? (
        <FormItem>
          <Label>{t("field.day")}</Label>
          <Controller
            control={form.control}
            name="day"
            render={({ field }) => (
              <DateField
                weekStart={weekStart}
                value={field.value}
                onChange={(next) => {
                  field.onChange(next);
                  form.setValue("dayIndex", Math.max(datesOfWeek(weekStart).indexOf(next), 0));
                }}
              />
            )}
          />
        </FormItem>
      ) : null}

      {variant !== "carNow" ? (
        <>
          <Controller
            control={form.control}
            name="tripShape"
            render={({ field }) => (
              <TripShapeControl
                value={field.value}
                onChange={(next) => {
                  const previousShape = field.value;
                  field.onChange(next);
                  // `departTime`/`returnTime` are two independent fields, but only one is ever
                  // shown for a one-way shape — carry the visible value across so switching shape
                  // doesn't silently swap in the other field's own (possibly stale) value.
                  if (next === "one_way_from" && previousShape !== "one_way_from") {
                    form.setValue("returnTime", form.getValues("departTime"), { shouldDirty: true });
                  } else if (previousShape === "one_way_from" && next !== "one_way_from") {
                    form.setValue("departTime", form.getValues("returnTime"), { shouldDirty: true });
                  }
                }}
              />
            )}
          />
          {quickContext && oneWay ? <p className="text-sm text-destructive">{t("quickRequest.oneWayHelp")}</p> : null}
        </>
      ) : null}

      <div className="flex gap-4">
        {variant !== "carNow" && tripShape !== "one_way_from" ? (
          <FormItem className="flex-1">
            <Label>{t("field.depart")}</Label>
            <Controller
              control={form.control}
              name="departTime"
              render={({ field }) => (
                <TimeField15
                  min="06:00"
                  value={field.value ?? "08:00"}
                  onChange={(next) => {
                    const previous = field.value ?? "08:00";
                    field.onChange(next);
                    const currentReturn = form.getValues("returnTime");
                    const shifted = shiftReturnByDepartureDelta(previous, next, currentReturn);
                    if (shifted !== currentReturn) form.setValue("returnTime", shifted, { shouldDirty: true, shouldValidate: true });
                  }}
                  aria-label={t("field.depart")}
                />
              )}
            />
            <FieldError message={form.formState.errors.departTime?.message} />
          </FormItem>
        ) : null}
        {tripShape !== "one_way_to" ? (
          <Controller
            control={form.control}
            name="returnTime"
            render={({ field }) =>
              variant === "carNow" ? (
                <></>
              ) : (
                <FormItem className="flex-1">
                  <Label>{tripShape === "one_way_from" ? t("request.departArrival") : t("field.return")}</Label>
                  <TimeField15 min="06:00" max="23:59" value={field.value ?? "12:00"} onChange={field.onChange} aria-label={t("field.return")} />
                  <FieldError message={form.formState.errors.returnTime?.message} />
                </FormItem>
              )
            }
          />
        ) : null}
      </div>

      {variant !== "carNow" && quickContext && tripShape === "one_way_from" ? <p className="text-xs text-muted-foreground">{t("quickRequest.arrivalHomeHelp")}</p> : null}
      {variant !== "carNow" && quickContext && oneWay ? <p className="text-xs text-muted-foreground">{tv("quickRequest.vehicleWindow", { start: formatTime(new Date(startMs)), end: formatTime(new Date(endMs)) })}</p> : null}

      {quickContext && !carIsFree ? (
        <div className="space-y-1.5 rounded-md border-s-4 border-amber-500 bg-amber-50 p-3 text-sm text-amber-900">
          <p>{isAway ? t("quickRequest.awayWarning") : t("quickRequest.overlapWarning")}</p>
          {otherFreeCar ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => form.setValue("preferredCarId", otherFreeCar.id, { shouldDirty: true })}
            >
              {tv("quickRequest.overlapOfferOtherCar", { car: otherFreeCar.name })}
            </Button>
          ) : (
            <p className="text-xs">{t("quickRequest.noCarFree")}</p>
          )}
        </div>
      ) : null}

      {tripShape === "round_trip" && variant !== "carNow" ? (
        <Controller
          control={form.control}
          name="needsCarAtDestination"
          render={({ field }) => <CarAtDestinationToggle checked={field.value} onChange={field.onChange} />}
        />
      ) : !quickContext ? (
        <Controller
          control={form.control}
          name="oneWayCarMode"
          render={({ field }) => (
            <OneWayCarModeControl
              value={field.value ?? null}
              tripShape={tripShape === "one_way_from" ? "one_way_from" : "one_way_to"}
              onChange={field.onChange}
            />
          )}
        />
      ) : null}
      {!quickContext ? <FieldError message={form.formState.errors.oneWayCarMode?.message} /> : null}

      <FormItem>
        <Label>{t("field.companions")}</Label>
        <Controller
          control={form.control}
          name="companions"
          render={({ field }) => (
            <CompanionPicker
              members={(membersQuery.data ?? []).map((m) => ({ id: m.id, name: m.name }))}
              value={field.value}
              onChange={field.onChange}
            />
          )}
        />
        <p className="text-sm text-muted-foreground">{tv("request.namedPassengerCount", { count: String(namedAdultCount) })}</p>
      </FormItem>

      <FormItem>
        <Label>{t("field.children")}</Label>
        <Controller control={form.control} name="children" render={({ field }) => (
          <CompanionPicker
            members={(childrenQuery.data ?? []).map((child) => ({
              ...child,
              name: child.age == null ? child.name : `${child.name} · ${child.age}`,
            }))}
            value={field.value}
            onChange={field.onChange}
            label={t("field.children")}
          />
        )} />
        <p className="text-sm text-muted-foreground">{tv("request.namedChildCount", { count: String(namedChildCount) })}</p>
      </FormItem>

      <FormItem>
        <Label htmlFor="request-guest-names">{t("quickRequest.guestPassengers")}</Label>
        <Controller control={form.control} name="guestNames" render={({ field }) => (
          <Textarea id="request-guest-names" value={field.value} onChange={field.onChange} rows={2} />
        )} />
        <p className="text-xs text-muted-foreground">{t("quickRequest.guestPassengersHelp")}</p>
        <FieldError message={form.formState.errors.guestNames?.message} />
      </FormItem>

      <Controller
        control={form.control}
        name="luggage"
        render={({ field }) => (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={field.value}
              onChange={(e) => field.onChange(e.target.checked)}
              className="size-4"
            />
            {t("field.luggage")}
          </label>
        )}
      />

      {variant !== "carNow" && tripShape !== "one_way_from" ? (
        <FormItem>
          <Label>{t("field.flexDepart")}</Label>
          <FlexibilityRange
            early={values.flexDepartEarly ?? 0}
            late={values.flexDepartLate ?? 0}
            onChange={(early, late) => {
              form.setValue("flexDepartEarly", early, { shouldDirty: true });
              form.setValue("flexDepartLate", late, { shouldDirty: true });
            }}
          />
        </FormItem>
      ) : null}
      {variant !== "carNow" && tripShape !== "one_way_to" ? (
        <FormItem>
          <Label>{t("field.flexReturn")}</Label>
          <FlexibilityRange
            early={values.flexReturnEarly ?? 0}
            late={values.flexReturnLate ?? 0}
            onChange={(early, late) => {
              form.setValue("flexReturnEarly", early, { shouldDirty: true });
              form.setValue("flexReturnLate", late, { shouldDirty: true });
            }}
          />
          <p className="text-xs text-muted-foreground">{t("request.flexibilityHelper")}</p>
        </FormItem>
      ) : null}

      {variant !== "carNow" ? (
        <FormItem>
          <Label htmlFor="request-description">{t("quickRequest.rideDescription")}</Label>
          <Controller control={form.control} name="rideDescription" render={({ field }) => <Textarea {...field} id="request-description" rows={2} maxLength={1000} aria-describedby="request-description-help" />} />
          <p id="request-description-help" className="text-xs text-muted-foreground">{t("quickRequest.rideDescriptionHelp")}</p>
          <FieldError message={form.formState.errors.rideDescription?.message} />
        </FormItem>
      ) : null}

      <FormItem>
        <Label htmlFor="request-notes">{t("field.notes")}</Label>
        <Controller control={form.control} name="notes" render={({ field }) => <Textarea {...field} id="request-notes" rows={2} />} />
      </FormItem>

      {variant === "weekly" ? (
        <Controller
          control={form.control}
          name="repeatWeekly"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between gap-3 rounded-md border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="request-repeat-weekly">{t("request.repeatWeekly")}</Label>
                <p className="text-xs text-muted-foreground">{t("request.repeatWeeklyHint")}</p>
              </div>
              <Switch id="request-repeat-weekly" checked={field.value} onCheckedChange={field.onChange} />
            </FormItem>
          )}
        />
      ) : null}

      <div
        className={cn(
          "fixed inset-x-0 z-30 border-t bg-background p-3",
          insideModalSheet ? "bottom-0" : "bottom-16 md:bottom-0",
        )}
      >
        <div className="mx-auto max-w-2xl space-y-2">
          {seatFitWarning ? <p className="text-sm text-amber-700">⚠ {t("request.seatFitWarning")}</p> : null}
          {duplicate ? <p className="text-sm text-amber-700">{t("request.duplicateWarning")}</p> : null}
          {quickContext && invalidTime ? <p role="alert" className="text-sm text-destructive">{outsideDay ? he.sadranProposal.sameDayOnly : he.rideEditing.invalidTime}</p> : null}
          {form.formState.submitCount > 0 && Object.keys(form.formState.errors).length > 0 ? (
            <p role="alert" className="text-sm text-destructive">
              {t("request.validationSummary")}
              {form.formState.errors.rideTypeId ? ` · ${t("request.rideTypeRequired")}` : ""}
              {form.formState.errors.destination ? ` · ${t("request.destinationRequired")}` : ""}
            </p>
          ) : null}
          {submitError ? <p className="text-sm text-destructive">{submitError}</p> : null}
          <Button
            type="submit"
            className="w-full"
            size="lg"
            disabled={submitMutation.isPending || (!!quickContext && (isPast || invalidTime))}
            title={quickContext && isPast ? t("quickRequest.pastSlotTooltip") : undefined}
          >
            {mode === "edit"
              ? t("action.saveRequest")
              : waitlist
                ? t("action.submitWaitlist")
                : quickContext
                  ? oneWay ? t("quickRequest.submitOneWay") : t("quickRequest.submit")
                  : t("action.submitRequest")}
          </Button>
          {quickContext && isPast ? <p className="text-xs text-destructive">{t("quickRequest.pastSlotTooltip")}</p> : null}
        </div>
      </div>
    </form>
  );
}
