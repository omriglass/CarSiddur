import { zodResolver } from "@hookform/resolvers/zod";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FieldErrors } from "react-hook-form";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SheetPortalContext } from "@/components/SheetPortalContext";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FormItem } from "@/components/ui/form";
import { datesOfWeek } from "@/components/dateFieldDates";
import { useScrollToFirstError } from "@/components/useScrollToFirstError";
import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useDepartmentMembers } from "@/features/auth/useDepartmentMembers";
import { useMyDepartments } from "@/features/auth/useMyDepartments";
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
import { DEFAULT_HOP_MINUTES } from "@/lib/rideRoute";
import { cn } from "@/lib/utils";
import { effectiveWeekSettings } from "@/lib/weekSettings";
// Import the seat-fit helper from its own module, not the `@/solver` barrel: the barrel pulls
// the entire solver into the eager member bundle (owner, 2026-09-14 bundle-size cleanup).
import { fits } from "@/solver/seatFit";
import type { Car as SolverCar } from "@/solver/types";

import type { DestinationValue } from "@/components/DestinationCombobox";

import { fetchChildRequestOverlaps, fetchChildren, fetchRequestVersion, probeSubmitRequest } from "../api";
import type { ChildOverlapRow, JoinableRideRow, RequestEditRow, SubmitRequestResult, SubmitSeriesRequestResult, TemplateSuggestion } from "../api";
import { dayLabel } from "../dayLabel";
import { CAR_NOW_DEFAULT_HOURS } from "../carNow";
import { findOverlappingRequest } from "../duplicate";
import { overlapCancelAction } from "../overlap";
import { QUICK_REQUEST_DURATION_HOURS, endTimeForDuration } from "../duration";
import { joinableRideDriverLabel } from "../joinableRides";
import { guestPassengerNames, quickVehicleWindow, resolveQuickOrigin } from "../quickRequest";
import {
  useJoinableRidesMutation,
  useMyRequests,
  useRequestCompanionsQuery,
  useSaveRequestTemplateMutation,
  useSetRequestCompanionsMutation,
  useSetRequestChildrenMutation,
  useRequestChildrenQuery,
  useRecentCompanionsQuery,
  useRequestFormLayout,
  useRouteMinutesQuery,
  useStopTemplateMutation,
  useSubmitRequestMutation,
  useSubmitSeriesRequestMutation,
  useCancelRideMutation,
  useWithdrawRequestMutation,
} from "../hooks";
import { editReturnInstant, intervalToFlexValue, toInstant, toSubmitRequestPayload } from "../mapper";
import { editSignature, isUnchangedEdit } from "../unchanged";
import { requestFormSchema, type RequestFormValues } from "../schema";
import { anchorFormFields, resolveCarTimes, switchOutAnchor, switchReturnAnchor } from "../timeAnchors";
import { windowCarTimes, windowFormFields, windowModeActive } from "../timeWindow";
import { recentDestinations } from "../recentDestinations";
import { destinationValueToPoint, hasDestination, outboundRoutePoints, returnRoutePoints } from "../routePoints";
import { planBFormFields } from "../planB";
import { isSeriesSubmission, seriesSpanDays } from "../series";
import { extraAdultsFromStored, payloadSeatCounts, unnamedChildSeatsFromStored } from "../seatCounts";
import { overlapNames } from "../overlapNames";
import { childOverlapMessage } from "../childOverlap";
import { releaseConfirmation, shouldOfferJoinableRides, toastSeriesSubmitOutcome, toastSubmitOutcome } from "../submitOutcome";
import { shouldSuggestChildcare } from "../childcareType";
import { suggestionToFormValues } from "../templatePrefill";
import { canUseDrivingTripTypes, initialTripType, tripTypeToLegacyFields } from "../tripType";
import { JoinableRidesDialog } from "./JoinableRidesDialog";
import { CarPreferenceFields } from "./requestForm/CarPreferenceFields";
import { DayAndTripShapeFields } from "./requestForm/DayAndTripShapeFields";
import { DestinationRideTypeFields } from "./requestForm/DestinationRideTypeFields";
import { FieldError } from "./requestForm/FieldError";
import { PlanBFields } from "./requestForm/PlanBFields";
import { OriginField } from "./requestForm/OriginField";
import { StopsField } from "./requestForm/StopsField";
import { FlexibilityFields, TimeFields } from "./requestForm/TimesFlexibilityFields";
import { PassengersFields } from "./requestForm/PassengersFields";
import { RepeatWeeklyField } from "./requestForm/RepeatWeeklyField";
import { SentenceFields } from "./requestForm/sentence/SentenceFields";
import { STAGE_ONE_FIELDS, isStageOneField } from "./requestForm/sentence/sentenceModel";

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
  /** REQ §13.93: the quick-request origin fallback when the car is not currently away. */
  baseLocationId?: string | null;
}

export interface QuickRequestAwayWindow {
  carId: string;
  awayFrom: string;
  awayUntil: string | null;
  /** REQ §13.93: where the car is while away — the quick-request origin. */
  locationId?: string;
  locationName?: string;
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
  /** `/requests/new?day=YYYY-MM-DD` (R11B4): only the day is preselected (when it is one of the week's dates). */
  dayPrefill?: string;
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
  // REQ §13.93: a placeholder until `RequestForm`'s own render-body sync resolves the real
  // default (the member's `default_origin_id` for this department, else home) once the
  // department/destinations catalog has loaded — see the "catalog may arrive after useForm
  // captures its initial defaults" comment below.
  origin: DestinationValue = { freeText: "" },
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
    origin,
    outStops: [],
    returnStops: [],
    rideTypeId,
    preferredCarId,
    tripShape: "round_trip",
    tripType: "round_trip",
    dropOffPickup: false,
    departTime,
    returnTime,
    departAnchor: "leave",
    arriveByTime: undefined,
    returnAnchor: "arrive",
    leaveDestTime: undefined,
    returnNextDay: false,
    oneWayCarMode: undefined,
    needsCarAtDestination: true,
    adults: 1,
    childSeats: 0,
    boosters: 0,
    extraAdults: 0,
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
    tripType: joinRide.isRelay ? "one_way" : "round_trip",
    dropOffPickup: false,
    departTime: timeFromInstant(joinRide.startsAt),
    returnTime: joinRide.isRelay ? undefined : timeFromInstant(joinRide.endsAt),
    oneWayCarMode: joinRide.isRelay ? "passenger" : undefined,
    needsCarAtDestination: !joinRide.isRelay,
  };
}

function mapEditRowToValues(row: RequestEditRow, weekStart: string, companions: string[], children: string[], extraAdults: number, unnamedChildSeats: number): RequestFormValues {
  const day = row.departAt ? dayFromInstant(row.departAt) : row.returnAt ? dayFromInstant(row.returnAt) : weekStart;
  const dates = datesOfWeek(weekStart);
  const departTime = row.departAt ? timeFromInstant(row.departAt) : undefined;
  const returnInstant = editReturnInstant(row);
  const returnTime = returnInstant ? timeFromInstant(returnInstant) : undefined;
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
    origin: row.originId
      ? { presetId: row.originId, name: row.originName ?? "" }
      : { freeText: row.originText ?? "" },
    outStops: row.outStops ?? [],
    returnStops: row.returnStops ?? [],
    rideTypeId: row.rideTypeId,
    preferredCarId: row.preferredCarId ?? "",
    tripShape: row.tripShape,
    ...initialTripType(row),
    departTime,
    returnTime: returnNextDay ? "23:59" : returnTime,
    ...anchorFormFields(row, timeFromInstant),
    // REQ §13.112 (a)/(b): the stored "אם אין רכב" line reopens as it was saved.
    ...planBFormFields(row, timeFromInstant),
    // REQ §13.112 (c): a window request reopens in window mode (the fixed fields keep the nominal block).
    ...windowFormFields({ durationLocked: row.durationLocked, departAt: row.departAt, returnAt: row.returnAt, flexReturnLate: row.flexReturnLate }),
    returnNextDay: false,
    oneWayCarMode: (row.oneWayCarMode ?? undefined) as "relay" | "passenger" | undefined,
    needsCarAtDestination: row.needsCarAtDestination,
    adults: row.adults,
    extraAdults,
    preferSpecificCar: !!row.preferredCarId,
    childSeats: children.length,
    // REQ §13.112 (d): the stored child seats minus the seat-using named children are the unnamed ones.
    legacyChildSeats: unnamedChildSeats,
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

/** First message among an array field's per-item errors (and its own). */
function stopsError(errors: unknown): string | undefined {
  if (!errors || typeof errors !== "object") return undefined;
  const list = Array.isArray(errors) ? errors : [errors];
  for (const item of list) {
    const message = (item as { message?: unknown } | undefined)?.message;
    if (typeof message === "string") return message;
  }
  return undefined;
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
  dayPrefill,
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
  // REQ §13.93: origin defaults (the member's own `default_origin_id` for this department, the
  // department home) and the non-driver trip-type gate (REQ §13.88).
  const activeDepartmentsQuery = useActiveDepartment();
  const myDepartmentsQuery = useMyDepartments();
  const companionsQuery = useRequestCompanionsQuery(initial?.id);
  const requestChildrenQuery = useRequestChildrenQuery(initial?.id);
  const recentCompanionsQuery = useRecentCompanionsQuery();
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
  const cancelRideMutation = useCancelRideMutation();

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
      dayPrefill && datesOfWeek(weekStart).includes(dayPrefill) ? dayPrefill : buildDefaultDay(weekStart, lastRequest?.departAt),
      defaultRideTypeId,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departmentId, weekStart, mode, defaultRideTypeId, variant, dayPrefill, joinRide?.rideId, templateSuggestion?.templateId, slotPrefill?.day, slotPrefill?.departTime, slotPrefill?.returnTime, slotPrefill?.carId]);

  const form = useForm<RequestFormValues>({
    resolver: zodResolver(requestFormSchema),
    defaultValues,
    mode: "onBlur",
  });
  const formRef = useRef<HTMLFormElement>(null);
  const onScrollToInvalid = useScrollToFirstError(form, formRef);
  // REQ §13.110 / UX_FLOWS §3.4a: one form state, two field arrangements (`profiles.classic_request_form`).
  const layout = useRequestFormLayout();
  const isSentence = layout === "sentence";
  // A failed submit also opens the sheet/row of the first bad field in the sentence layout.
  const [invalidSignal, setInvalidSignal] = useState<{ field: string; n: number } | null>(null);
  // Weekly sentence requests have two stages: 1 = the sentence, 2 = the modifiers (UX_FLOWS §3.4a).
  const twoStage = isSentence && variant === "weekly";
  const [stage, setStage] = useState<1 | 2>(1);
  function signalInvalid(field: string) {
    setInvalidSignal((previous) => ({ field, n: (previous?.n ?? 0) + 1 }));
  }
  function onInvalid(errors: FieldErrors<RequestFormValues>) {
    onScrollToInvalid(errors);
    if (!isSentence) return;
    // A stage-1 error sends the member back to the sentence and opens that chip's sheet; a stage-2
    // error stays where it is (the scroll above already focused it).
    const stageOne = Object.keys(errors).find(isStageOneField);
    if (stageOne) {
      setStage(1);
      signalInvalid(stageOne);
    } else {
      const first = Object.keys(errors)[0];
      if (first) signalInvalid(first);
    }
  }
  async function goToStageTwo() {
    const ok = await form.trigger([...STAGE_ONE_FIELDS]);
    if (ok) {
      setStage(2);
      return;
    }
    const first = STAGE_ONE_FIELDS.find((field) => field in form.formState.errors);
    if (first) signalInvalid(first);
  }

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
  const [baselineSignature, setBaselineSignature] = useState<string | null>(null);
  // Named children of the department (own children first). Declared before the edit reset below,
  // which needs them to tell an adult-seat child from a child-seat one (R9B1 prefill).
  const childReferenceYear = Number((form.getValues("day") || weekStart).slice(0, 4));
  const childrenQuery = useQuery({ queryKey: ["children", departmentId, session?.user.id, childReferenceYear], queryFn: () => fetchChildren(departmentId, session!.user.id, childReferenceYear), enabled: !!session?.user.id });
  // Set only by `PortalSheetContent`/`PortalDialogContent` (`QuickRequestSheet`'s host) — reused
  // here to tell the submit bar it is inside a sheet: sticky within the sheet's scroll container,
  // no app tab bar to clear (SheetPortalContext.ts).
  const insideModalSheet = useContext(SheetPortalContext) !== null;
  const linkedChildrenKnown =
    requestChildrenQuery.isSuccess && (requestChildrenQuery.data.length === 0 || childrenQuery.isSuccess || childrenQuery.isError);
  if (mode === "edit" && initial && companionsQuery.isSuccess && linkedChildrenKnown) {
    const nextResetKey = `${initial.id}:${initial.version}`;
    if (nextResetKey !== resetKey) {
      const linkedAdultChildren = (childrenQuery.data ?? []).filter(
        (child) => requestChildrenQuery.data?.includes(child.id) && child.isAdultPassenger,
      ).length;
      const extraAdults = extraAdultsFromStored({
        storedAdults: initial.adults,
        companionsCount: companionsQuery.data.length,
        guestsCount: (initial.guestPassengerNames ?? []).length,
        adultChildrenCount: linkedAdultChildren,
      });
      const linkedSeatChildren = (childrenQuery.data ?? []).filter(
        (child) => requestChildrenQuery.data?.includes(child.id) && !child.isAdultPassenger,
      ).length;
      // Children whose age is unknown (the catalog failed to load) are taken as seat children, like `set_request_children` does.
      const unknownSeatChildren = childrenQuery.data ? 0 : requestChildrenQuery.data.length;
      const unnamedChildSeats = unnamedChildSeatsFromStored({ storedChildSeats: initial.childSeats, seatChildrenCount: linkedSeatChildren + unknownSeatChildren });
      const mapped = mapEditRowToValues(initial, weekStart, companionsQuery.data, requestChildrenQuery.data, extraAdults, unnamedChildSeats);
      form.reset(mapped);
      // R11B1: the loaded request in the same normalized form the save compares against (parsed like a submit would be).
      const parsed = requestFormSchema.safeParse(mapped);
      setBaselineSignature(editSignature(parsed.success ? parsed.data : mapped, { anchorSync: isSentence && variant === "weekly" }));
      setResetKey(nextResetKey);
    }
  }
  const hasResetForEdit = mode !== "edit" || resetKey !== null;

  const values = useWatch({ control: form.control });
  const tripShape = values.tripShape ?? "round_trip";
  const oneWay = tripShape !== "round_trip";
  const tripTypeValue = values.tripType ?? "round_trip";
  // G2: only a drop-off with no pickup leg looks for a driver; a הלוך בלבד is "I take the car".
  const seeksDriver = oneWay && tripTypeValue === "drop_off";
  // REQ §13.93 "Multi-stop rides": return-stops only make sense on a leg that actually returns
  // (הלוך-חזור, or הקפצה with the pickup switch on) — same gate `mapper.ts`/`submit_request`
  // use ("tripShape !== 'one_way_to'" <=> the RPC's own `return_at is not null` check).
  const needsReturn = tripShape !== "one_way_to";
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

  // REQ §13.93: the department home and the member's own default origin for this department —
  // `carNow` is pinned to home; `quick` defaults to wherever the slot's car actually is
  // (`resolveQuickOrigin`); everything else defaults to the member's `default_origin_id`, else
  // home. `null` while the department/destinations catalogs have not loaded yet.
  const homeDestinationId = activeDepartmentsQuery.departments.find((d) => d.id === departmentId)?.home_destination_id ?? null;
  const homeName = destinationsQuery.data?.find((d) => d.id === homeDestinationId)?.name ?? "";
  const myDefaultOriginId = myDepartmentsQuery.data?.find((d) => d.department_id === departmentId)?.default_origin_id ?? homeDestinationId;
  const resolvedOrigin: DestinationValue | null = (() => {
    if (variant === "carNow") {
      return homeDestinationId ? { presetId: homeDestinationId, name: homeName } : null;
    }
    if (variant === "quick" && quickContext) {
      if (!homeDestinationId) return null;
      const carId = values.preferredCarId || "";
      const atMs = Date.parse(toInstant(day, values.departTime || "08:00", false));
      const car = quickContext.cars.find((c) => c.id === carId);
      return resolveQuickOrigin({
        carId,
        atMs,
        awayWindows: quickContext.awayWindows ?? [],
        baseLocationId: car?.baseLocationId,
        baseLocationName: car?.baseLocationId ? destinationsQuery.data?.find((d) => d.id === car.baseLocationId)?.name : undefined,
        homeId: homeDestinationId,
        homeName,
      });
    }
    if (!myDefaultOriginId) return null;
    return { presetId: myDefaultOriginId, name: destinationsQuery.data?.find((d) => d.id === myDefaultOriginId)?.name ?? "" };
  })();
  // Applies the resolved default once per distinct value (so the member's own tap-to-edit choice
  // is never fought), and only for a request that has no origin of its own yet (edit/join/template
  // prefills already carry the real stored origin). In an effect, not during render: a
  // render-time `form.setValue` reached the form state but not the already-mounted origin
  // `Controller`, which kept showing an empty "מ אל" (found by e2e 2026-10-04). The applied key
  // lives in a ref, so no state is set inside the effect.
  const appliedOriginKeyRef = useRef<string | null>(null);
  const shouldApplyOrigin = mode !== "edit" && !joinRide && !templateSuggestion && !!resolvedOrigin;
  const resolvedOriginKey = resolvedOrigin ? JSON.stringify(resolvedOrigin) : null;
  useEffect(() => {
    if (!shouldApplyOrigin || !resolvedOriginKey || resolvedOriginKey === appliedOriginKeyRef.current) return;
    form.setValue("origin", JSON.parse(resolvedOriginKey) as DestinationValue, { shouldDirty: false });
    appliedOriginKeyRef.current = resolvedOriginKey;
  }, [form, shouldApplyOrigin, resolvedOriginKey]);

  // REQ §13.88/§13.93: a non-driver with no driving companion selected may only file a drop-off.
  const companionDoesNotDriveById = new Map((membersQuery.data ?? []).map((m) => [m.id, m.doesNotDrive]));
  const canDrive = canUseDrivingTripTypes(profileQuery.data?.does_not_drive ?? false, values.companions ?? [], companionDoesNotDriveById);
  const tripType = values.tripType ?? "round_trip";
  const dropOffPickup = values.dropOffPickup ?? false;
  if (!canDrive && tripType !== "drop_off") {
    const forced = tripTypeToLegacyFields("drop_off", dropOffPickup);
    form.setValue("tripType", "drop_off", { shouldDirty: true });
    form.setValue("tripShape", forced.tripShape, { shouldDirty: true, shouldValidate: true });
    form.setValue("needsCarAtDestination", forced.needsCarAtDestination, { shouldDirty: true });
    form.setValue("oneWayCarMode", forced.oneWayCarMode, { shouldDirty: true });
  }
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

  // REQ §13.110 (b): route minutes of each leg (`route_minutes_preview`) turn an "arrive by" /
  // "leave there at" time into the car's own times. Only the weekly sentence layout anchors.
  const anchorSyncActive = isSentence && variant === "weekly";
  const routeValues = {
    origin: (values.origin ?? { freeText: "" }) as DestinationValue,
    destination: (values.destination ?? { freeText: "" }) as DestinationValue,
    outStops: (values.outStops ?? []) as DestinationValue[],
    returnStops: (values.returnStops ?? []) as DestinationValue[],
  };
  const routesWanted = anchorSyncActive && hasDestination(routeValues.destination);
  const outRouteQuery = useRouteMinutesQuery(departmentId, outboundRoutePoints(routeValues), routesWanted);
  const returnRouteQuery = useRouteMinutesQuery(departmentId, returnRoutePoints(routeValues), routesWanted && needsReturn);
  // Plan B (REQ §13.112): origin -> drop place, for the drop time sheet's "leave at" anchor.
  const altPlaceValue = values.altPlace as DestinationValue | undefined;
  const planBRouteQuery = useRouteMinutesQuery(
    departmentId,
    [routeValues.origin, altPlaceValue ?? { freeText: "" }].map(destinationValueToPoint),
    anchorSyncActive && values.fallback === "alternative" && hasDestination(altPlaceValue),
  );
  // Unknown travel = 60 minutes (REQ §13.109), also when the preview call failed.
  const outMinutes = outRouteQuery.data ?? (outRouteQuery.isError ? DEFAULT_HOP_MINUTES : null);
  const returnMinutes = returnRouteQuery.data ?? (returnRouteQuery.isError ? DEFAULT_HOP_MINUTES : null);
  const planBMinutes = planBRouteQuery.data ?? (planBRouteQuery.isError ? DEFAULT_HOP_MINUTES : null);

  // Keeps `departTime`/`returnTime` (what is submitted) equal to the car times implied by the
  // typed anchors; a multi-day request has no anchors (its legs share one payload).
  const watchedDepartAnchor = values.departAnchor;
  const watchedArriveBy = values.arriveByTime;
  const watchedReturnAnchor = values.returnAnchor;
  const watchedLeaveDest = values.leaveDestTime;
  useEffect(() => {
    if (!anchorSyncActive) return;
    const current = form.getValues();
    if (isMultiDay) {
      if (current.departAnchor !== "leave") {
        const patch = switchOutAnchor(current, "leave");
        form.setValue("departAnchor", patch.departAnchor);
        form.setValue("arriveByTime", patch.arriveByTime);
        form.setValue("departTime", patch.departTime);
      }
      if (current.returnAnchor !== "arrive") {
        const patch = switchReturnAnchor(current, "arrive");
        form.setValue("returnAnchor", patch.returnAnchor);
        form.setValue("leaveDestTime", patch.leaveDestTime);
        form.setValue("returnTime", patch.returnTime);
      }
      return;
    }
    const times = resolveCarTimes(current, { outMinutes, returnMinutes });
    if (times.departTime !== current.departTime) form.setValue("departTime", times.departTime, { shouldDirty: true });
    if (times.returnTime !== current.returnTime) form.setValue("returnTime", times.returnTime, { shouldDirty: true });
  }, [anchorSyncActive, isMultiDay, outMinutes, returnMinutes, watchedDepartAnchor, watchedArriveBy, watchedReturnAnchor, watchedLeaveDest, form]);
  const guests = guestPassengerNames(values.guestNames ?? "");
  // The requester is always one adult; every selected member, named child aged eight or
  // older and guest name is another. Named children below eight use a child seat instead.
  const selectedChildren = (childrenQuery.data ?? []).filter((child) => values.children?.includes(child.id));
  const namedAdultCount = 1 + (values.extraAdults ?? 0) + (values.companions?.length ?? 0) + selectedChildren.filter((child) => child.isAdultPassenger).length + guests.length;
  const selectedChildSeatCount = selectedChildren.filter((child) => !child.isAdultPassenger).length;
  // REQ §13.112 (d): unnamed child seats are on top of the named children (boosters are counted separately below).
  const namedChildCount = selectedChildSeatCount + (values.legacyChildSeats ?? 0);
  // R11U5: the origin place is never offered as destination, stop or plan-B place.
  const originPresetId = values.origin && "presetId" in values.origin ? values.origin.presetId : undefined;
  const destinationsWithoutOrigin = (destinationsQuery.data ?? []).filter((d) => d.id !== originPresetId);
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
        luggageCapacity: c.features.includes("large_trunk") ? 1 : 0,
        maintenance: [],
      }));
    return cars.length > 0 && !cars.some((c) => fits(c, passengers));
  }, [carsQuery.data, seatConfigsQuery.data, namedAdultCount, namedChildCount, values.boosters]);

  const duplicate = useMemo(() => {
    if (!values.departTime && !values.returnTime) return null;
    // REQ §13.112 (c): a window request overlaps whatever its earliest block overlaps (the member's own other requests).
    const windowTimes = windowModeActive({ timeMode: values.timeMode, tripType: values.tripType, tripShape, day, returnDay: values.returnDay }) ? windowCarTimes({ windowHours: values.windowHours, windowStart: values.windowStart, windowEnd: values.windowEnd }) : null;
    const departAt = windowTimes
      ? toInstant(day, windowTimes.departTime, false)
      : tripShape !== "one_way_from" && values.departTime ? toInstant(day, values.departTime, false) : null;
    const returnAt = windowTimes
      ? toInstant(day, windowTimes.returnTime, false)
      : tripShape !== "one_way_to" && values.returnTime
        ? toInstant(day, values.returnTime, false)
        : null;
    const candidates = (myRequestsQuery.data ?? []).filter(
      (r) => r.departmentId === departmentId && !["withdrawn", "cancelled", "denied", "external"].includes(r.status),
    );
    return findOverlappingRequest({ departAt, returnAt }, candidates, initial?.id);
  }, [day, tripShape, values.departTime, values.returnTime, values.timeMode, values.tripType, values.returnDay, values.windowHours, values.windowStart, values.windowEnd, myRequestsQuery.data, departmentId, initial?.id]);

  // Quick-variant-only: free-window pre-validation (server RPC remains the sole authority).
  const departTimeSafe = values.departTime || "08:00";
  const returnTimeSafe = values.returnTime || "12:00";
  const primaryTime = tripShape === "one_way_from" ? (values.returnTime ?? "") : (values.departTime ?? "");
  const selectedMs = Date.parse(toInstant(day, tripShape === "one_way_from" ? returnTimeSafe : departTimeSafe, false));
  const roundTripEndMs = Date.parse(toInstant(day, returnTimeSafe, false));
  const destinationId = values.destination && "presetId" in values.destination ? values.destination.presetId : undefined;
  const travelMinutes = destinationsQuery.data?.find((d) => d.id === destinationId)?.travel_minutes ?? DEFAULT_HOP_MINUTES;
  const dwellMinutes = effectiveWeekSettings(settingsQuery.data, weekRowQuery.data).chauffeurDwellMinutes;
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

  // R9U7/R9F1: a child on a new request suggests the childcare ride type while the member has not picked one.
  const rideTypeTouched = !!form.formState.dirtyFields.rideTypeId;
  function onChildAdded() {
    const childcareId = shouldSuggestChildcare({
      rideTypes: rideTypesQuery.data ?? [],
      currentRideTypeId: form.getValues("rideTypeId"),
      touched: rideTypeTouched,
      isNew: mode === "new",
    });
    if (childcareId) form.setValue("rideTypeId", childcareId, { shouldValidate: true });
  }

  const [submitError, setSubmitError] = useState<string | null>(null);
  // >7-day multi-day span (REQ §13.77, UX_FLOWS.md §3.4): holds the just-validated form
  // values while the "לשמור רכב ליותר משבוע?" confirmation is open; `performSubmit` runs
  // either straight from `onSubmit` (span ≤ 7 days) or from the dialog's own confirm.
  const [pendingSeriesSubmit, setPendingSeriesSubmit] = useState<RequestFormValues | null>(null);
  // REQ §13.101 g (QM7): the form values held while "overlaps one of your own rides" is asked.
  const [pendingOverlapSubmit, setPendingOverlapSubmit] = useState<RequestFormValues | null>(null);
  // REQ §13.101 f (QM5): the edit the server wants confirmed (release to the waiting list).
  // R2M4: named children already on another member's overlapping request — warn, allow anyway.
  const [pendingChildOverlap, setPendingChildOverlap] = useState<{ values: RequestFormValues; rows: ChildOverlapRow[] } | null>(null);
  // R2B20 / REQ §102 f: an open-week edit the probe says would lose the member's current car.
  const [pendingLose, setPendingLose] = useState<RequestFormValues | null>(null);
  const [pendingRelease, setPendingRelease] = useState<{ values: RequestFormValues; drivesOthers: boolean; wouldPlace: boolean } | null>(null);
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

  /** R11B1: an edit that changes nothing is a no-op — no server call, no dialog. */
  function finishUnchanged() {
    toast(t("request.noChanges"));
    if (onDone) onDone(null);
    else navigate(paths.my());
  }

  async function onSubmit(formValues: RequestFormValues) {
    if (mode === "edit" && isUnchangedEdit(formValues, baselineSignature, { anchorSync: anchorSyncActive })) {
      finishUnchanged();
      return;
    }
    if (duplicate && !waitlist) {
      // The server may know better than the client check (`unchanged: true` on its probe): then there is nothing to ask.
      if (mode === "edit" && !isSeriesSubmit(formValues)) {
        try {
          const probe = await probeSubmitRequest(buildPayload(formValues, {}));
          if (probe?.unchanged) {
            finishUnchanged();
            return;
          }
        } catch { /* advisory only */ }
      }
      setPendingOverlapSubmit(formValues);
      return;
    }
    continueSubmit(formValues);
  }

  function continueSubmit(formValues: RequestFormValues) {
    const returnDay = formValues.returnDay;
    const multiDay = isSeriesSubmit(formValues);
    if (multiDay && seriesSpanDays(formValues.day, returnDay!) > 7) {
      setPendingSeriesSubmit(formValues);
      return;
    }
    void performSubmit(formValues);
  }

  /** The `submit_request` payload of validated form values (also used by the unchanged probe). */
  function buildPayload(formValues: RequestFormValues, options: { confirmRelease?: boolean }) {
    const isSeriesRequest = isSeriesSubmit(formValues);
    const guestNamesList = guestPassengerNames(formValues.guestNames);
    // REQ §13.93: only a הקפצה without a pickup books the quick missing-driver ride; a
    // הלוך בלבד leaves the car at the destination and goes through normal placement.
    const isOneWayDropOff = formValues.tripType === "drop_off" && formValues.tripShape !== "round_trip";
    // Seat counts exclude the *selected* children on purpose — `set_request_children()` (called
    // right after) adds them, re-classified by birth year, and subtracts the children the
    // request had before; see `payloadSeatCounts` for the contract and the double-count bug.
    const previousChildIds = new Set(mode === "edit" ? (requestChildrenQuery.data ?? []) : []);
    const seatCounts = payloadSeatCounts({
      companionsCount: formValues.companions.length,
      guestsCount: guestNamesList.length,
      legacyChildSeats: formValues.legacyChildSeats,
      extraAdults: formValues.extraAdults,
      previousChildren: (childrenQuery.data ?? []).filter((child) => previousChildIds.has(child.id)),
    });
    return {
      ...toSubmitRequestPayload(
        { ...formValues, adults: seatCounts.adults, childSeats: seatCounts.childSeats },
        {
          requestId: initial?.id,
          expectedVersion: initial?.version,
          joinRideId: mode === "new" ? joinRide?.rideId : undefined,
          guestPassengerNames: guestNamesList,
          reserveMissingDriver: variant === "quick" && isOneWayDropOff ? true : undefined,
          layout,
          isSeries: isSeriesRequest,
          planB: variant === "weekly",
          // R11B2: a flexibility the member did not touch keeps its exact stored value (a window's slack is not a form value).
          storedFlex: mode === "edit" && initial
            ? { departEarly: initial.flexDepartEarly, departLate: initial.flexDepartLate, returnEarly: initial.flexReturnEarly, returnLate: initial.flexReturnLate }
            : undefined,
        },
      ),
      ...(waitlist ? { waitlist: true } : {}),
      ...(options.confirmRelease ? { confirm_release: true } : {}),
      // REQ §13.111 (a): a quick / car-now request is placed right away - the server asks before using a car with no large trunk.
      ...(variant === "quick" || variant === "carNow" ? { ask_small_trunk: true } : {}),
      // Only a *new* request can link to an existing template on creation (`submit_request`'s
      // insert branch is the only place it reads `template_id`); an edit's own template link,
      // if any, is managed separately below via save/stop, never touched by this payload.
      ...(mode === "new" && templateSuggestion ? { template_id: templateSuggestion.templateId } : {}),
    };
  }

  async function performSubmit(formValues: RequestFormValues, options: { confirmRelease?: boolean; confirmLose?: boolean; ignoreChildOverlap?: boolean } = {}) {
    if (quickContext && (isPast || invalidTime)) return;
    setSubmitError(null);
    const isSeriesRequest = isSeriesSubmit(formValues);
    const payload = buildPayload(formValues, options);

    // The request this template link/unlink applies to, resolved once so both the "on" and
    // "off" branches below agree: an edit keeps its own row's template, a prefilled new
    // request inherits the suggestion's.
    const existingTemplateId = mode === "edit" ? (initial?.templateId ?? undefined) : templateSuggestion?.templateId;

    try {
      // R2M4: warn (never block) when a named child is on someone else's overlapping request.
      const childNames = (childrenQuery.data ?? []).filter((c) => formValues.children.includes(c.id)).map((c) => c.name);
      const anchor = payload.depart_at ?? payload.return_at;
      if (!options.ignoreChildOverlap && childNames.length > 0 && anchor) {
        try {
          const rows = await fetchChildRequestOverlaps({
            departmentId,
            childNames,
            departAt: payload.depart_at ?? anchor,
            returnAt: payload.return_at ?? anchor,
            excludeRequestId: initial?.id,
          });
          if (rows.length > 0) {
            setPendingChildOverlap({ values: formValues, rows });
            return;
          }
        } catch { /* advisory only */ }
      }
      // R2B20: an edit of an assigned request in an open week may drop its car — probe first.
      if (!isSeriesRequest && !options.confirmLose && !options.confirmRelease && !waitlist && mode === "edit" && initial?.status === "assigned") {
        try {
          const probe = await probeSubmitRequest(payload);
          if (probe?.unchanged) {
            finishUnchanged();
            return;
          }
          if (probe?.would_lose_booking) {
            setPendingLose(formValues);
            return;
          }
        } catch { /* advisory only */ }
      }
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
        if (!toastSeriesSubmitOutcome(seriesResult)) toast.success(t("request.submitSent"));
        if (onDone) onDone(null);
        else navigate(paths.my());
        return;
      }

      const raw = await submitMutation.mutateAsync(payload);
      const result = raw as unknown as SubmitRequestResult | null;
      const requestId = result?.request_id ?? initial?.id;

      // R11B1: the server found nothing to change — no release/overlap questions, no outcome toast.
      if (result?.unchanged) {
        finishUnchanged();
        return;
      }

      // REQ §13.101 f (QM5): nothing changed yet — ask, then resubmit with `confirm_release`.
      const release = releaseConfirmation(result);
      if (release) {
        setPendingRelease({ values: formValues, ...release });
        return;
      }

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
      const outcomeToasted = toastSubmitOutcome(result, {
        carName: (id) => carLookup.find((c) => c.id === id)?.name ?? "",
        preferredCarId: formValues.preferredCarId,
        tripType: formValues.tripType,
        departTime: formValues.departTime,
        returnTime: formValues.returnTime,
        onViewRequests: () => navigate(paths.my()),
        overlapNames: overlapNames(result?.overlaps, myRequestsQuery.data ?? []),
      });
      // R9M3: an open/solving-week submit has no server outcome to report — confirm it ourselves
      // (the quick/car-now sheets always get an outcome toast from a live-week result).
      if (!outcomeToasted && variant === "weekly") toast.success(t(mode === "edit" ? "request.submitSaved" : "request.submitSent"));

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

  /** REQ §13.101 g (QM7): cancel the member's own overlapping request/ride, then submit. */
  async function cancelOverlapAndSubmit() {
    const values = pendingOverlapSubmit;
    if (!values || !duplicate) return;
    const action = overlapCancelAction(duplicate);
    try {
      if (action.kind === "cancelRide") {
        await cancelRideMutation.mutateAsync({ rideId: action.rideId, reason: "CANCELLED_BY_MEMBER", expectedVersion: action.expectedVersion });
      } else {
        await withdrawMutation.mutateAsync({ requestId: action.requestId, expectedVersion: action.expectedVersion });
      }
    } catch {
      return; // the mutation already toasted; keep the dialog open
    }
    setPendingOverlapSubmit(null);
    continueSubmit(values);
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

  const isLoading = destinationsQuery.isLoading || rideTypesQuery.isLoading || profileQuery.isLoading || !hasResetForEdit;

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        <div className="h-11 animate-pulse rounded-md bg-muted" />
        <div className="h-11 animate-pulse rounded-md bg-muted" />
        <div className="h-11 animate-pulse rounded-md bg-muted" />
      </div>
    );
  }

  // R9U4: in the sentence layout the seat/overlap warnings live in the page under the sentence,
  // never in the sticky footer (where they covered stage-2 content).
  // R11U4: "edit it instead of opening a new request" is a new-request hint — never on the edit screen (the save asks instead).
  const duplicateHint = duplicate && mode !== "edit";
  const overlapSeries = !!duplicate && !!duplicate.seriesId && (duplicate.seriesCount ?? 0) > 1;
  const notices =
    seatFitWarning || duplicateHint ? (
      <div className="space-y-1" data-testid="form-notices">
        {seatFitWarning ? <p className="text-sm text-amber-700">⚠ {t("request.seatFitWarning")}</p> : null}
        {duplicateHint ? <p className="text-sm text-amber-700">{t("request.duplicateWarning")}</p> : null}
      </div>
    ) : null;

  return (
    <>
    <form
      ref={formRef}
      onSubmit={(event) => {
        // Stage 1 has no submit: Enter / implicit submission moves on to stage 2 instead.
        if (twoStage && stage === 1) {
          event.preventDefault();
          void goToStageTwo();
          return;
        }
        return form.handleSubmit(onSubmit, onInvalid)(event);
      }}
      className={cn("mx-auto flex max-w-2xl flex-col p-4", isSentence ? "gap-3 pt-1" : "gap-5", insideModalSheet ? "" : "pb-28")}
    >
      {quickContext ? (
        <p className="text-base font-semibold">
          {seeksDriver
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

      {isSentence ? (
        <SentenceFields
          form={form}
          variant={variant}
          weekStart={weekStart}
          departmentId={departmentId}
          day={day}
          errors={form.formState.errors}
          destinations={destinationsQuery.data ?? []}
          rideTypes={rideTypesQuery.data ?? []}
          preferredCars={preferredCars}
          initialPreferredCarName={initial?.preferredCarName}
          members={membersQuery.data ?? []}
          childOptions={childrenQuery.data ?? []}
          tripShape={tripShape}
          tripType={tripType}
          dropOffPickup={dropOffPickup}
          canDrive={canDrive}
          seeksDriver={seeksDriver}
          isQuickContext={!!quickContext}
          showReturnDayPicker={showReturnDayPicker}
          returnAnotherDay={returnAnotherDay}
          setReturnAnotherDay={setReturnAnotherDay}
          isMultiDay={isMultiDay}
          multiDaySpan={multiDaySpan}
          routeMinutes={{ out: outMinutes, return: returnMinutes, planB: planBMinutes }}
          mode={mode}
          notices={notices}
          onChildAdded={onChildAdded}
          recentDestinations={recentDestinations(myRequestsQuery.data ?? [])}
          recentCompanionIds={recentCompanionsQuery.data ?? []}
          stage={twoStage ? stage : 1}
          onStageChange={setStage}
          invalidSignal={invalidSignal}
          quickContext={quickContext ? { cars: quickContext.cars, showCarPicker: quickContext.showCarPicker } : undefined}
          quickWindow={{ startMs, endMs, carIsFree, isAway, otherFreeCar, oneWay }}
        />
      ) : (
        <>
        <OriginField
          control={form.control}
          destinations={destinationsQuery.data ?? []}
          editable={variant !== "carNow"}
        />

        {/* REQ §13.93 "Multi-stop rides": compact chips between the origin line and the
            destination field, behind one "+ עצירה" link — not shown for carNow (fixed home
            round trip, no room/need for stops). */}
        {variant !== "carNow" ? (
          <StopsField
            control={form.control}
            name="outStops"
            error={stopsError(form.formState.errors.outStops)}
            destinations={destinationsWithoutOrigin}
            addLabel={he.request.addStop}
            removeAriaLabel={he.request.removeStop}
          />
        ) : null}

        <DestinationRideTypeFields
          control={form.control}
          destinations={destinationsWithoutOrigin}
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
          seeksDriver={seeksDriver}
          tripType={tripType}
          dropOffPickup={dropOffPickup}
          canDrive={canDrive}
          departmentId={departmentId}
          destinations={destinationsQuery.data ?? []}
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

        {/* REQ §13.93 "Multi-stop rides": return-stop chips, next to the return time, only when
            the trip actually has a return leg — behind one "+ עצירה בחזור" link. */}
        {variant !== "carNow" && needsReturn ? (
          <StopsField
            control={form.control}
            name="returnStops"
            error={stopsError(form.formState.errors.returnStops)}
            destinations={destinationsWithoutOrigin}
            addLabel={he.request.addReturnStop}
            removeAriaLabel={he.request.removeStop}
          />
        ) : null}

        {/* REQ §13.112 (e): the classic layout's own plan-B section (the sentence layout has the "אם אין רכב" line). */}
        {variant === "weekly" ? <PlanBFields form={form} errors={form.formState.errors} destinations={destinationsWithoutOrigin} /> : null}

        <PassengersFields
          control={form.control}
          members={membersQuery.data ?? []}
          children={childrenQuery.data ?? []}
          onChildAdded={onChildAdded}
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
              <div className="space-y-1" data-field="luggage">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={field.value}
                    onChange={(e) => field.onChange(e.target.checked)}
                    className="size-4"
                  />
                  {t("request.luggageLabel")}
                </label>
                <p className="text-xs text-muted-foreground">{t("request.luggageHint")}</p>
              </div>
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
        </>
      )}

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
          {isSentence ? null : (
            <>
              {seatFitWarning ? <p className="text-sm text-amber-700">⚠ {t("request.seatFitWarning")}</p> : null}
              {duplicateHint ? <p className="text-sm text-amber-700">{t("request.duplicateWarning")}</p> : null}
            </>
          )}
          {quickContext && invalidTime ? <p role="alert" className="text-sm text-destructive">{outsideDay ? he.sadranProposal.sameDayOnly : he.rideEditing.invalidTime}</p> : null}
          {form.formState.submitCount > 0 && Object.keys(form.formState.errors).length > 0 ? (
            <p role="alert" className="text-sm text-destructive">
              {t("request.validationSummary")}
              {form.formState.errors.rideTypeId ? ` · ${t("request.rideTypeRequired")}` : ""}
              {form.formState.errors.destination ? ` · ${t("request.destinationRequired")}` : ""}
            </p>
          ) : null}
          {submitError ? <p className="text-sm text-destructive">{submitError}</p> : null}
          {twoStage && stage === 1 ? (
            <Button key="next" type="button" className="w-full" size="lg" onClick={() => void goToStageTwo()} data-testid="stage-next">
              {he.requestSentence.next}
            </Button>
          ) : (
          <Button
            key="submit"
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
                  ? seeksDriver ? t("quickRequest.submitOneWay") : oneWay ? t("quickRequest.submitOneWayTakeCar") : t("quickRequest.submit")
                  : t("action.submitRequest")}
          </Button>
          )}
          {quickContext && isPast ? <p className="text-xs text-destructive">{t("quickRequest.pastSlotTooltip")}</p> : null}
        </div>
      </div>
    </form>
    <ConfirmDialog
      open={!!pendingLose}
      onOpenChange={(open) => { if (!open) setPendingLose(null); }}
      title={t("request.loseBookingTitle")}
      description={t("request.loseBookingBody")}
      loading={submitMutation.isPending}
      onConfirm={() => {
        const values = pendingLose;
        setPendingLose(null);
        if (values) void performSubmit(values, { confirmLose: true, ignoreChildOverlap: true });
      }}
    />
    <ConfirmDialog
      open={!!pendingChildOverlap}
      onOpenChange={(open) => { if (!open) setPendingChildOverlap(null); }}
      title={t("request.childOverlapTitle")}
      confirmLabel={t("request.childOverlapConfirm")}
      cancelLabel={t("request.overlapBack")}
      onConfirm={() => {
        const pending = pendingChildOverlap;
        setPendingChildOverlap(null);
        if (pending) void performSubmit(pending.values, { ignoreChildOverlap: true });
      }}
    >
      <ul className="space-y-1 text-sm">
        {(pendingChildOverlap?.rows ?? []).map((row) => (
          <li key={`${row.requestId}:${row.childName}`}>{childOverlapMessage(row)}</li>
        ))}
      </ul>
    </ConfirmDialog>
    <ConfirmDialog
      open={!!pendingRelease}
      onOpenChange={(open) => { if (!open) setPendingRelease(null); }}
      title={t(pendingRelease?.wouldPlace ? "request.releaseKeepPassengersTitle" : "request.releaseTitle")}
      description={t(pendingRelease?.wouldPlace ? "request.releaseKeepPassengersBody" : "request.releaseBody")}
      loading={submitMutation.isPending}
      onConfirm={() => {
        const pending = pendingRelease;
        setPendingRelease(null);
        if (pending) void performSubmit(pending.values, { confirmRelease: true });
      }}
    >
      {pendingRelease?.drivesOthers && !pendingRelease.wouldPlace ? <p className="text-sm">{t("request.releaseDrivesOthers")}</p> : null}
    </ConfirmDialog>
    <ConfirmDialog
      open={!!pendingOverlapSubmit}
      onOpenChange={(open) => { if (!open) setPendingOverlapSubmit(null); }}
      title={t("request.overlapTitle")}
      description={overlapSeries ? tv("request.overlapSeriesBody", { count: String(duplicate?.seriesCount ?? 0) }) : t("request.overlapBody")}
      confirmLabel={t("request.overlapCancelOther")}
      cancelLabel={t("request.overlapBack")}
      // R11U4: cancelling one leg of a multi-day request would cancel the whole series, so that option is not offered from here.
      hideConfirm={overlapSeries}
      destructive
      loading={withdrawMutation.isPending || cancelRideMutation.isPending}
      onConfirm={() => void cancelOverlapAndSubmit()}
    >
      {duplicate ? (
        <p className="text-sm font-medium" data-testid="overlap-other">
          <bdi>{tv("request.overlapOther", { name: overlapNames([{ request_id: duplicate.id, ride_id: null }], [duplicate])[0] ?? duplicate.destination })}</bdi>
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={() => {
          const values = pendingOverlapSubmit;
          setPendingOverlapSubmit(null);
          if (values) continueSubmit(values);
        }}
      >
        {t("request.overlapKeepBoth")}
      </Button>
    </ConfirmDialog>
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
