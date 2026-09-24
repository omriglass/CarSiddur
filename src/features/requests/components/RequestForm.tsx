import { zodResolver } from "@hookform/resolvers/zod";
import { useContext, useMemo, useRef, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SheetPortalContext } from "@/components/SheetPortalContext";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FormItem } from "@/components/ui/form";
import { datesOfWeek } from "@/components/dateFieldDates";
import { useScrollToFirstError } from "@/components/useScrollToFirstError";
import { useDepartmentMembers } from "@/features/auth/useDepartmentMembers";
import { useProfile } from "@/features/auth/useProfile";
import { useSession } from "@/features/auth/useSession";
import { useCars, useCarSeatConfigs, useDestinations, useRideTypes, useSuggestDestinationMutation } from "@/features/fleet/hooks";
import { useDepartmentSettings, useWeekRow } from "@/features/sadran/hooks";
import { isSlotFree, type CarFreeWindow } from "@/features/siddur/freeWindows";
import { buildAddPassengerInputs } from "@/features/rides/addPassengers";
import { fetchBoardRideById } from "@/features/siddur/api";
import type { RidePassengerInput } from "@/features/rides/api";
import { useAddRidePassengersMutation } from "@/features/rides/hooks";
import { siddurKeys } from "@/features/siddur/queryKeys";
import { paths } from "@/app/routes";
import { he, t, tv } from "@/i18n/he";
import { dateKey, formatTime, weekdayIndex } from "@/lib/time";
import { cn } from "@/lib/utils";
// Import the seat-fit helper from its own module, not the `@/solver` barrel: the barrel pulls
// the entire solver into the eager member bundle (owner, 2026-09-14 bundle-size cleanup).
import { fits } from "@/solver/seatFit";
import type { Car as SolverCar } from "@/solver/types";

import { fetchChildren, fetchRequestVersion } from "../api";
import type { JoinableRideRow, RequestEditRow, SubmitRequestResult, SubmitSeriesRequestResult, TemplateSuggestion } from "../api";
import { dayLabel } from "../dayLabel";
import { CAR_NOW_DEFAULT_HOURS } from "../carNow";
import { findOverlappingRequest } from "../duplicate";
import { QUICK_REQUEST_DURATION_HOURS, endTimeForDuration } from "../duration";
import { joinableRideDriverLabel } from "../joinableRides";
import { guestPassengerNames, quickVehicleWindow } from "../quickRequest";
import {
  useJoinableRidesMutation,
  useMyRequests,
  useRequestCompanionsQuery,
  useSaveRequestTemplateMutation,
  useSetRequestCompanionsMutation,
  useSetRequestChildrenMutation,
  useRequestChildrenQuery,
  useStopTemplateMutation,
  useSubmitRequestMutation,
  useSubmitSeriesRequestMutation,
  useWithdrawRequestMutation,
} from "../hooks";
import { intervalToFlexValue, toInstant, toSubmitRequestPayload } from "../mapper";
import { requestFormSchema, type RequestFormValues } from "../schema";
import { isSeriesSubmission, seriesSpanDays } from "../series";
import { payloadSeatCounts } from "../seatCounts";
import { shouldOfferJoinableRides, toastSeriesSubmitOutcome, toastSubmitOutcome } from "../submitOutcome";
import { suggestionToFormValues } from "../templatePrefill";
import { JoinableRidesDialog } from "./JoinableRidesDialog";
import { CarPreferenceFields } from "./requestForm/CarPreferenceFields";
import { DayAndTripShapeFields } from "./requestForm/DayAndTripShapeFields";
import { DestinationRideTypeFields } from "./requestForm/DestinationRideTypeFields";
import { FieldError } from "./requestForm/FieldError";
import { FlexibilityFields, TimeFields } from "./requestForm/TimesFlexibilityFields";
import { PassengersFields } from "./requestForm/PassengersFields";
import { RepeatWeeklyField } from "./requestForm/RepeatWeeklyField";

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
  /** Called after a successful submit instead of the default `navigate(paths.my())`. */
  onDone?: (result: SubmitRequestResult | null) => void;
}

function dayFromInstant(instant: string): string {
  return dateKey(instant);
}
function timeFromInstant(instant: string): string {
  return formatTime(new Date(instant));
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
    // Defaults to a same-day request; the weekly/new-mode return-day picker below can move
    // it later (REQ §13.77).
    returnDay: day,
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
    // Editing an existing (single-day) request never shows the return-day picker
    // (multi-day editing is not supported in v1, REQ §13.77) — kept equal to `day`.
    returnDay: day,
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
  const profileQuery = useProfile();
  const companionsQuery = useRequestCompanionsQuery(initial?.id);
  const requestChildrenQuery = useRequestChildrenQuery(initial?.id);
  const settingsQuery = useDepartmentSettings(departmentId);
  const weekRowQuery = useWeekRow(departmentId, weekStart);

  const submitMutation = useSubmitRequestMutation();
  const submitSeriesMutation = useSubmitSeriesRequestMutation();
  const joinableRidesMutation = useJoinableRidesMutation();
  const setCompanionsMutation = useSetRequestCompanionsMutation();
  const setChildrenMutation = useSetRequestChildrenMutation();
  const suggestDestinationMutation = useSuggestDestinationMutation(departmentId);
  const saveTemplateMutation = useSaveRequestTemplateMutation();
  const stopTemplateMutation = useStopTemplateMutation();
  // Joinable-rides dialog "הצטרפות לנסיעה" (REQ §13.85, owner decision 2026-09-14): joins the
  // chosen ride directly via `add_ride_passengers()` with the just-filed request's own people,
  // then withdraws that now-redundant waitlisted request — see `performSubmit`/`joinNow` below.
  const addRidePassengersMutation = useAddRidePassengersMutation();
  const withdrawMutation = useWithdrawRequestMutation();

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
  const formRef = useRef<HTMLFormElement>(null);
  const onInvalid = useScrollToFirstError(form, formRef);

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
  // here to tell the submit bar it is inside a sheet: sticky within the sheet's scroll container,
  // no app tab bar to clear (SheetPortalContext.ts).
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
  // carNow has no return-time picker — `returnTime` tracks the fixed (preset, hidden)
  // `departTime` plus the visible `durationHours` select instead. Its own `Controller` below
  // stays mounted (rendering `null`) specifically so this write reaches `useWatch`'s `values`
  // snapshot, used by the free-car/duplicate checks further down: an unmounted `Controller`
  // would leave `values` reading a permanently stale value instead of the live write.
  if (variant === "carNow" && values.departTime) {
    const computedReturn = endTimeForDuration(values.departTime, values.durationHours ?? CAR_NOW_DEFAULT_HOURS).time;
    if (form.getValues("returnTime") !== computedReturn) {
      form.setValue("returnTime", computedReturn, { shouldValidate: true });
    }
  }
  const day = values.day ?? weekStart;
  // Multi-day ("series") request (REQ §13.77, UX_FLOWS.md §3.4): the return-day picker only
  // makes sense for a brand-new weekly round trip — editing a series is not supported in v1,
  // and the quick/carNow variants are always about a single live day.
  const showReturnDayPicker = variant === "weekly" && mode === "new" && tripShape === "round_trip";
  const returnDayValue = values.returnDay ?? day;
  // The return-day picker is collapsed behind a small "return another day" link because
  // multi-day requests are rare; a later return day keeps it expanded (UX_FLOWS.md §3.4).
  const [returnAnotherDay, setReturnAnotherDay] = useState(false);
  const isMultiDay = showReturnDayPicker && returnAnotherDay && returnDayValue !== day;
  const multiDaySpan = isMultiDay ? seriesSpanDays(day, returnDayValue) : null;
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
  // >7-day multi-day span (REQ §13.77, UX_FLOWS.md §3.4): holds the just-validated form
  // values while the "לשמור רכב ליותר משבוע?" confirmation is open; `performSubmit` runs
  // either straight from `onSubmit` (span ≤ 7 days) or from the dialog's own confirm.
  const [pendingSeriesSubmit, setPendingSeriesSubmit] = useState<RequestFormValues | null>(null);
  // F4 (docs/TODO.md, owner A8-A10): a `waitlisted` outcome with nearby joinable rides holds off
  // the normal onDone/navigate — `afterJoinableDialog` runs it once the member picks "ask to
  // join" or "stay on the waiting list". State (not a ref): it's only ever set from an event
  // handler and read from another, never during render.
  const [joinableRides, setJoinableRides] = useState<JoinableRideRow[] | null>(null);
  const [afterJoinableDialog, setAfterJoinableDialog] = useState<() => void>(() => () => {});
  // The just-filed (now waitlisted) request's own people, captured at submit time so
  // "הצטרפות לנסיעה" can add them straight onto the chosen ride (item 4, REQ §13.85) without
  // re-deriving them from form state a second time later.
  const [joinRequestContext, setJoinRequestContext] = useState<{ requestId: string; peopleInputs: RidePassengerInput[] } | null>(null);

  /** Same gate as `isMultiDay` above, so the hint and the filed request never disagree (B1). */
  function isSeriesSubmit(formValues: RequestFormValues): boolean {
    return isSeriesSubmission({ pickerShown: showReturnDayPicker, pickerOpen: returnAnotherDay, day: formValues.day, returnDay: formValues.returnDay });
  }

  function onSubmit(formValues: RequestFormValues) {
    const returnDay = formValues.returnDay;
    const multiDay = isSeriesSubmit(formValues);
    if (multiDay && seriesSpanDays(formValues.day, returnDay!) > 7) {
      setPendingSeriesSubmit(formValues);
      return;
    }
    void performSubmit(formValues);
  }

  async function performSubmit(formValues: RequestFormValues) {
    if (quickContext && (isPast || invalidTime)) return;
    setSubmitError(null);
    const isSeriesRequest = isSeriesSubmit(formValues);
    const guestNamesList = guestPassengerNames(formValues.guestNames);
    const isOneWay = formValues.tripShape !== "round_trip";
    // Seat counts exclude the *selected* children on purpose — `set_request_children()` (called
    // right after) adds them, re-classified by birth year, and subtracts the children the
    // request had before; see `payloadSeatCounts` for the contract and the double-count bug.
    const previousChildIds = new Set(mode === "edit" ? (requestChildrenQuery.data ?? []) : []);
    const seatCounts = payloadSeatCounts({
      companionsCount: formValues.companions.length,
      guestsCount: guestNamesList.length,
      legacyChildSeats: formValues.legacyChildSeats,
      previousChildren: (childrenQuery.data ?? []).filter((child) => previousChildIds.has(child.id)),
    });
    const payload = {
      ...toSubmitRequestPayload(
        { ...formValues, adults: seatCounts.adults, childSeats: seatCounts.childSeats },
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
      if (isSeriesRequest) {
        // Multi-day request (REQ §13.77): `submit_series_request` returns one `request_id`
        // per calendar day of the span — passengers/children apply to every leg so they show
        // on each day's ride, not just the first.
        const raw = await submitSeriesMutation.mutateAsync(payload);
        const seriesResult = raw as unknown as SubmitSeriesRequestResult | null;
        for (const requestId of seriesResult?.request_ids ?? []) {
          await setCompanionsMutation.mutateAsync({ requestId, profileIds: formValues.companions });
          await setChildrenMutation.mutateAsync({ requestId, childIds: formValues.children });
        }
        if ("freeText" in formValues.destination && formValues.destination.freeText.trim()) {
          suggestDestinationMutation.mutate({ name: formValues.destination.freeText.trim() });
        }
        toastSeriesSubmitOutcome(seriesResult);
        if (onDone) onDone(null);
        else navigate(paths.my());
        return;
      }

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
        onViewRequests: () => navigate(paths.my()),
      });

      const proceed = () => {
        if (onDone) onDone(result);
        else navigate(paths.my());
      };

      // F4 (docs/TODO.md, owner A8-A10): a waitlisted outcome only ever happens against a
      // published/live week (try_auto_approve()/enter_waiting_list() already ran, same gate
      // `toastSubmitOutcome`'s `waitlisted` branch uses) — offer nearby joinable rides before
      // leaving the member to just wait. Best-effort: a failed lookup never blocks the normal
      // outcome.
      if (shouldOfferJoinableRides(result) && requestId) {
        try {
          const rides = await joinableRidesMutation.mutateAsync(requestId);
          if (rides.length > 0) {
            const selfId = session?.user.id;
            setAfterJoinableDialog(() => proceed);
            setJoinRequestContext({
              requestId,
              peopleInputs: [
                ...(selfId ? [{ person_id: selfId, display_name: profileQuery.data?.full_name ?? "", seat_kind: "adult" as const }] : []),
                ...buildAddPassengerInputs(formValues.companions, formValues.children, formValues.guestNames, membersQuery.data ?? [], childrenQuery.data ?? []),
              ],
            });
            setJoinableRides(rides);
            return;
          }
        } catch { /* non-fatal — fall through to the normal outcome */ }
      }

      proceed();
    } catch {
      setSubmitError(variant === "quick" || variant === "carNow" ? t("quickRequest.submitError") : t("request.submitError"));
    }
  }

  /**
   * "הצטרפות לנסיעה" (item 4, REQ §13.85, owner decision 2026-09-14): joins the chosen
   * joinable ride directly via `add_ride_passengers()` with the just-filed request's own
   * people (self + companions + children + guests, captured in `joinRequestContext` at
   * submit time), then withdraws that now-redundant waitlisted request. `add_ride_passengers`
   * needs the ride's current `version` — `fetchJoinableRides`'s row carries none, so this
   * re-reads the ride fresh (`fetchBoardRideById`) right before the call; likewise the
   * request's version is re-read (`fetchRequestVersion`) rather than assumed, since it may
   * have been edited since `submit_request` returned. On `ride_seats_exceeded` (or any other
   * failure) the mutation's own `onError` already toasted it — the dialog stays open and the
   * waitlisted request is left untouched (withdraw never runs unless the add succeeded).
   */
  async function joinNow(rideId: string) {
    const context = joinRequestContext;
    if (!context) return;
    try {
      const ride = await fetchBoardRideById(rideId);
      if (!ride?.id || ride.version == null) throw new Error("ride_not_found");
      await addRidePassengersMutation.mutateAsync({ rideId: ride.id, expectedVersion: ride.version, passengers: context.peopleInputs });

      const requestVersion = await fetchRequestVersion(context.requestId);
      if (requestVersion != null) {
        await withdrawMutation.mutateAsync({ requestId: context.requestId, expectedVersion: requestVersion });
      }

      const joined = joinableRides?.find((r) => r.rideId === rideId);
      toast.success(tv("joinableRides.joined", { driver: joined ? joinableRideDriverLabel(joined) : "" }));
      setJoinableRides(null);
      setJoinRequestContext(null);
      afterJoinableDialog();
    } catch {
      /* add_ride_passengers/withdraw already toasted its own error — keep the dialog open and
         the waitlisted request untouched. */
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
    <>
    <form
      ref={formRef}
      onSubmit={form.handleSubmit(onSubmit, onInvalid)}
      className={cn("mx-auto flex max-w-2xl flex-col gap-5 p-4", insideModalSheet ? "" : "pb-28")}
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

      <DestinationRideTypeFields
        control={form.control}
        destinations={destinationsQuery.data ?? []}
        rideTypes={rideTypesQuery.data ?? []}
        tripShape={tripShape}
        variant={variant}
        destinationHasError={!!form.formState.errors.destination}
        rideTypeError={form.formState.errors.rideTypeId?.message}
      />

      <CarPreferenceFields
        control={form.control}
        variant={variant}
        preferredCars={preferredCars}
        initialPreferredCarName={initial?.preferredCarName}
        quickContext={quickContext ? { cars: quickContext.cars, showCarPicker: quickContext.showCarPicker } : undefined}
      />

      <DayAndTripShapeFields
        control={form.control}
        form={form}
        weekStart={weekStart}
        variant={variant}
        showReturnDayPicker={showReturnDayPicker}
        returnAnotherDay={returnAnotherDay}
        setReturnAnotherDay={setReturnAnotherDay}
        day={day}
        isMultiDay={isMultiDay}
        multiDaySpan={multiDaySpan}
        isQuickContext={!!quickContext}
        oneWay={oneWay}
      />

      <TimeFields
        form={form}
        variant={variant}
        tripShape={tripShape}
        isQuickContext={!!quickContext}
        oneWay={oneWay}
        startMs={startMs}
        endMs={endMs}
        carIsFree={carIsFree}
        isAway={isAway}
        otherFreeCar={otherFreeCar}
        departTimeError={form.formState.errors.departTime?.message}
        returnTimeError={form.formState.errors.returnTime?.message}
      />

      <PassengersFields
        control={form.control}
        members={membersQuery.data ?? []}
        children={childrenQuery.data ?? []}
        namedAdultCount={namedAdultCount}
        namedChildCount={namedChildCount}
        guestNamesError={form.formState.errors.guestNames?.message}
      />

      {/* Luggage, flexibility and the note to the Sadran are weekly-solver inputs; a same-day
          quick/car-now request is placed immediately with nobody reading them (owner, 2026-09-14). */}
      {variant === "weekly" ? (
        <Controller
          control={form.control}
          name="luggage"
          render={({ field }) => (
            <label className="flex items-center gap-2 text-sm" data-field="luggage">
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
      ) : null}

      <FlexibilityFields
        form={form}
        variant={variant}
        tripShape={tripShape}
        isMultiDay={isMultiDay}
        flexDepartEarly={values.flexDepartEarly ?? 0}
        flexDepartLate={values.flexDepartLate ?? 0}
        flexReturnEarly={values.flexReturnEarly ?? 0}
        flexReturnLate={values.flexReturnLate ?? 0}
      />

      {variant !== "carNow" ? (
        <FormItem data-field="rideDescription">
          <Label htmlFor="request-description">{t("quickRequest.rideDescription")}</Label>
          <Controller control={form.control} name="rideDescription" render={({ field }) => <Textarea {...field} id="request-description" rows={2} maxLength={1000} aria-describedby="request-description-help" />} />
          <p id="request-description-help" className="text-xs text-muted-foreground">{t("quickRequest.rideDescriptionHelp")}</p>
          <FieldError message={form.formState.errors.rideDescription?.message} />
        </FormItem>
      ) : null}

      {variant === "weekly" ? (
        <FormItem data-field="notes">
          <Label htmlFor="request-notes">{t("field.notes")}</Label>
          <Controller control={form.control} name="notes" render={({ field }) => <Textarea {...field} id="request-notes" rows={2} />} />
        </FormItem>
      ) : null}

      {variant === "weekly" && !isMultiDay ? <RepeatWeeklyField control={form.control} /> : null}

      <div
        className={cn(
          "z-30 border-t bg-background p-3",
          // Inside the quick-request sheet the bar is `sticky` at the bottom of the sheet's own
          // scroll container (`max-h-[85dvh] overflow-y-auto`), not `fixed`: the sheet content is
          // transformed by its slide-in animation (and `-translate-x-1/2` on md), which makes it
          // the containing block for `fixed` descendants — Safari then kept the bar wherever it
          // first rendered and scrolled it away with the form (owner, 2026-09-14). The negative
          // margins cancel the form's own `p-4` so the bar spans the sheet's content width.
          insideModalSheet ? "sticky bottom-0 -mx-4 -mb-4" : "fixed inset-x-0 bottom-16 md:bottom-0",
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
            disabled={submitMutation.isPending || submitSeriesMutation.isPending || (!!quickContext && (isPast || invalidTime))}
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
    <ConfirmDialog
      open={!!pendingSeriesSubmit}
      onOpenChange={(open) => { if (!open) setPendingSeriesSubmit(null); }}
      title={t("request.multiDayLongTitle")}
      description={
        pendingSeriesSubmit
          ? tv("request.multiDayLongBody", {
              days: String(seriesSpanDays(pendingSeriesSubmit.day, pendingSeriesSubmit.returnDay ?? pendingSeriesSubmit.day)),
            })
          : undefined
      }
      loading={submitSeriesMutation.isPending}
      onConfirm={() => {
        const values = pendingSeriesSubmit;
        setPendingSeriesSubmit(null);
        if (values) void performSubmit(values);
      }}
    />
    <JoinableRidesDialog
      open={!!joinableRides}
      onOpenChange={(open) => { if (!open) { setJoinableRides(null); setJoinRequestContext(null); afterJoinableDialog(); } }}
      rides={joinableRides ?? []}
      radiusKm={settingsQuery.data?.join_radius_km ?? 10}
      onAskToJoin={(rideId) => void joinNow(rideId)}
      onStay={() => {
        setJoinableRides(null);
        setJoinRequestContext(null);
        afterJoinableDialog();
      }}
    />
    </>
  );
}
