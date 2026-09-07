import { zodResolver } from "@hookform/resolvers/zod";
import { formatInTimeZone } from "date-fns-tz";
import { useMemo, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FormItem } from "@/components/ui/form";
import { CarAtDestinationToggle } from "@/components/CarAtDestinationToggle";
import { CompanionPicker } from "@/components/CompanionPicker";
import { DateField, datesOfWeek } from "@/components/DateField";
import { DestinationCombobox, type DestinationValue } from "@/components/DestinationCombobox";
import { FlexibilityRange } from "@/components/FlexibilitySegmented";
import { OneWayCarModeControl } from "@/components/OneWayCarModeControl";
import { PassengerStepper } from "@/components/PassengerStepper";
import { RideTypeChips } from "@/components/RideTypeChips";
import { TimeField15 } from "@/components/TimeField15";
import { TripShapeControl } from "@/components/TripShapeControl";
import { useDepartmentMembers } from "@/features/auth/useDepartmentMembers";
import { useCars, useCarSeatConfigs, useDestinations, useRideTypes, useSuggestDestinationMutation } from "@/features/fleet/hooks";
import { t, tv } from "@/i18n/he";
import { TZ } from "@/lib/time";
import { fits, type Car as SolverCar } from "@/solver";

import type { RequestEditRow } from "../api";
import { findOverlappingRequest } from "../duplicate";
import {
  useMyRequests,
  useRequestCompanionsQuery,
  useSetRequestCompanionsMutation,
  useSubmitRequestMutation,
} from "../hooks";
import { intervalToFlexValue, toInstant, toSubmitRequestPayload } from "../mapper";
import { requestFormSchema, type RequestFormValues } from "../schema";

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

interface RequestFormProps {
  mode: "new" | "edit";
  departmentId: string;
  weekStart: string;
  /** Edit mode only. */
  initial?: RequestEditRow;
  /** "Ask to join" prefill from `/requests/new?ride=<id>` (UX_FLOWS §3.4/§3.5). */
  joinRide?: JoinRidePrefill;
  /**
   * Day/time prefill from clicking an empty grid cell on an Open/Solving-week siddur
   * (UX_FLOWS.md §18): unlike the live-week flow (`QuickRequestSheet`, which knows and
   * targets one specific car), the Sadran hasn't solved this week yet, so there is no car to
   * pin — only the day and start time carry over, exactly like typing them in by hand.
   */
  slotPrefill?: { day: string; departTime: string };
}

function dayFromInstant(instant: string): string {
  return formatInTimeZone(new Date(instant), TZ, "yyyy-MM-dd");
}
function timeFromInstant(instant: string): string {
  return formatInTimeZone(new Date(instant), TZ, "HH:mm");
}

function buildDefaultDay(weekStart: string, lastDepartAt: string | null | undefined): string {
  if (!lastDepartAt) return weekStart; // datesOfWeek(weekStart)[0] === weekStart (the Sunday itself)
  const dates = datesOfWeek(weekStart);
  const weekday = Number(formatInTimeZone(new Date(lastDepartAt), TZ, "i")) % 7; // 0=Sun..6=Sat, matches datesOfWeek order
  return dates[weekday] ?? weekStart;
}

function emptyValues(
  departmentId: string,
  weekStart: string,
  day: string,
  rideTypeId: string,
  departTime = "08:00",
  returnTime = "12:00",
): RequestFormValues {
  const dates = datesOfWeek(weekStart);
  return {
    departmentId,
    weekStart,
    day,
    dayIndex: Math.max(dates.indexOf(day), 0),
    destination: { freeText: "" },
    rideTypeId,
    preferredCarId: "",
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
    luggage: false,
    flexDepartEarly: 0,
    flexDepartLate: 0,
    flexReturnEarly: 0,
    flexReturnLate: 0,
    notes: "",
    rideDescription: "",
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

function mapEditRowToValues(row: RequestEditRow, weekStart: string, companions: string[]): RequestFormValues {
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
    childSeats: row.childSeats,
    boosters: row.boosters,
    companions,
    luggage: row.hasLuggage,
    flexDepartEarly: intervalToFlexValue(row.flexDepartEarly),
    flexDepartLate: intervalToFlexValue(row.flexDepartLate),
    flexReturnEarly: intervalToFlexValue(row.flexReturnEarly),
    flexReturnLate: intervalToFlexValue(row.flexReturnLate),
    notes: row.notes ?? "",
    rideDescription: row.rideDescription ?? "",
  };
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p role="alert" className="text-sm font-medium text-destructive">{message}</p>;
}

/**
 * New/edit request form (UX_FLOWS.md §3.4, component inventory `RequestForm`).
 * One screen, sticky footer, smart defaults, non-blocking seat-fit and
 * duplicate warnings, submits via `submit_request` (CLAUDE.md decision 8).
 */
export function RequestForm({ mode, departmentId, weekStart, initial, joinRide, slotPrefill }: RequestFormProps) {
  const navigate = useNavigate();

  const destinationsQuery = useDestinations();
  const rideTypesQuery = useRideTypes();
  const carsQuery = useCars(departmentId);
  const seatConfigsQuery = useCarSeatConfigs(departmentId);
  const myRequestsQuery = useMyRequests();
  const membersQuery = useDepartmentMembers(departmentId);
  const companionsQuery = useRequestCompanionsQuery(initial?.id);

  const submitMutation = useSubmitRequestMutation();
  const setCompanionsMutation = useSetRequestCompanionsMutation();
  const suggestDestinationMutation = useSuggestDestinationMutation();

  const lastRequest = [...(myRequestsQuery.data ?? [])]
    .filter((r) => r.departAt)
    .sort((a, b) => new Date(b.departAt as string).getTime() - new Date(a.departAt as string).getTime())[0];
  const defaultRideTypeId = rideTypesQuery.data?.find((type) => type.code === "other")?.id ?? rideTypesQuery.data?.[0]?.id ?? "";

  const defaultValues = useMemo(() => {
    if (mode === "edit") return emptyValues(departmentId, weekStart, weekStart, defaultRideTypeId);
    if (joinRide) return buildJoinRideValues(departmentId, weekStart, defaultRideTypeId, joinRide);
    if (slotPrefill) {
      return emptyValues(
        departmentId,
        weekStart,
        slotPrefill.day,
        defaultRideTypeId,
        slotPrefill.departTime,
      );
    }
    return emptyValues(
      departmentId,
      weekStart,
      buildDefaultDay(weekStart, lastRequest?.departAt),
      defaultRideTypeId,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departmentId, weekStart, mode, defaultRideTypeId, joinRide?.rideId, slotPrefill?.day, slotPrefill?.departTime]);

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
  if (mode === "edit" && initial && companionsQuery.isSuccess) {
    const nextResetKey = `${initial.id}:${initial.version}`;
    if (nextResetKey !== resetKey) {
      form.reset(mapEditRowToValues(initial, weekStart, companionsQuery.data));
      setResetKey(nextResetKey);
    }
  }
  const hasResetForEdit = mode !== "edit" || resetKey !== null;

  const values = useWatch({ control: form.control });
  const tripShape = values.tripShape ?? "round_trip";
  const day = values.day ?? weekStart;
  const preferredCars = (carsQuery.data ?? []).filter((car) => car.type === "shared" && car.status === "active");

  const seatFitWarning = useMemo(() => {
    if (!carsQuery.data || !seatConfigsQuery.data) return false;
    const passengers = {
      adults: values.adults ?? 1,
      childSeats: values.childSeats ?? 0,
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
  }, [carsQuery.data, seatConfigsQuery.data, values.adults, values.childSeats, values.boosters]);

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

  const [submitError, setSubmitError] = useState<string | null>(null);

  async function onSubmit(formValues: RequestFormValues) {
    setSubmitError(null);
    const payload = toSubmitRequestPayload(formValues, {
      requestId: initial?.id,
      expectedVersion: initial?.version,
      joinRideId: mode === "new" ? joinRide?.rideId : undefined,
    });

    try {
      const result = (await submitMutation.mutateAsync(payload)) as { request_id?: string } | null;
      const requestId = result?.request_id ?? initial?.id;

      if (requestId) {
        await setCompanionsMutation.mutateAsync({ requestId, profileIds: formValues.companions });
      }
      if ("freeText" in formValues.destination && formValues.destination.freeText.trim()) {
        suggestDestinationMutation.mutate({ name: formValues.destination.freeText.trim() });
      }
      navigate("/requests");
    } catch {
      setSubmitError(t("request.submitError"));
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
    <form onSubmit={form.handleSubmit(onSubmit)} className="mx-auto flex max-w-2xl flex-col gap-5 p-4 pb-28">
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

      <Controller
        control={form.control}
        name="tripShape"
        render={({ field }) => <TripShapeControl value={field.value} onChange={field.onChange} />}
      />

      <div className="flex gap-4">
        {tripShape !== "one_way_from" ? (
          <FormItem className="flex-1">
            <Label>{t("field.depart")}</Label>
            <Controller
              control={form.control}
              name="departTime"
              render={({ field }) => (
                <TimeField15 min="06:00" value={field.value ?? "08:00"} onChange={field.onChange} aria-label={t("field.depart")} />
              )}
            />
            <FieldError message={form.formState.errors.departTime?.message} />
          </FormItem>
        ) : null}
        {tripShape !== "one_way_to" ? (
          <FormItem className="flex-1">
            <Label>{tripShape === "one_way_from" ? t("request.departArrival") : t("field.return")}</Label>
            <Controller
              control={form.control}
              name="returnTime"
              render={({ field }) => (
                <TimeField15 min="06:00" max="23:59" value={field.value ?? "12:00"} onChange={field.onChange} aria-label={t("field.return")} />
              )}
            />
            <FieldError message={form.formState.errors.returnTime?.message} />
          </FormItem>
        ) : null}
      </div>



      {tripShape === "round_trip" ? (
        <Controller
          control={form.control}
          name="needsCarAtDestination"
          render={({ field }) => <CarAtDestinationToggle checked={field.value} onChange={field.onChange} />}
        />
      ) : (
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
      )}
      <FieldError message={form.formState.errors.oneWayCarMode?.message} />

      <FormItem>
        <Label>{t("field.passengers")}</Label>
        <Controller
          control={form.control}
          name="adults"
          render={({ field: adultsField }) => (
            <Controller
              control={form.control}
              name="childSeats"
              render={({ field: childField }) => (
                <Controller
                  control={form.control}
                  name="boosters"
                  render={({ field: boosterField }) => (
                    <PassengerStepper
                      value={{
                        adults: adultsField.value,
                        childSeats: childField.value,
                        boosters: boosterField.value,
                      }}
                      onChange={(next) => {
                        adultsField.onChange(next.adults);
                        childField.onChange(next.childSeats);
                        boosterField.onChange(next.boosters);
                      }}
                    />
                  )}
                />
              )}
            />
          )}
        />
      </FormItem>

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

      {tripShape !== "one_way_from" ? (
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
      {tripShape !== "one_way_to" ? (
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

      <FormItem>
        <Label htmlFor="request-description">{t("quickRequest.rideDescription")}</Label>
        <Controller control={form.control} name="rideDescription" render={({ field }) => <Textarea {...field} id="request-description" rows={2} maxLength={1000} aria-describedby="request-description-help" />} />
        <p id="request-description-help" className="text-xs text-muted-foreground">{t("quickRequest.rideDescriptionHelp")}</p>
        <FieldError message={form.formState.errors.rideDescription?.message} />
      </FormItem>

      <FormItem>
        <Label htmlFor="request-notes">{t("field.notes")}</Label>
        <Controller control={form.control} name="notes" render={({ field }) => <Textarea {...field} id="request-notes" rows={2} />} />
      </FormItem>

      <div className="fixed inset-x-0 bottom-16 z-30 border-t bg-background p-3 md:bottom-0">
        <div className="mx-auto max-w-2xl space-y-2">
          {seatFitWarning ? <p className="text-sm text-amber-700">⚠ {t("request.seatFitWarning")}</p> : null}
          {duplicate ? <p className="text-sm text-amber-700">{t("request.duplicateWarning")}</p> : null}
          {form.formState.submitCount > 0 && Object.keys(form.formState.errors).length > 0 ? (
            <p role="alert" className="text-sm text-destructive">
              {t("request.validationSummary")}
              {form.formState.errors.rideTypeId ? ` · ${t("request.rideTypeRequired")}` : ""}
              {form.formState.errors.destination ? ` · ${t("request.destinationRequired")}` : ""}
            </p>
          ) : null}
          {submitError ? <p className="text-sm text-destructive">{submitError}</p> : null}
          <Button type="submit" className="w-full" size="lg" disabled={submitMutation.isPending}>
            {mode === "edit" ? t("action.saveRequest") : t("action.submitRequest")}
          </Button>
        </div>
      </div>
    </form>
  );
}
