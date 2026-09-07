import { format, getDay, parseISO } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DestinationCombobox, type DestinationPreset, type DestinationValue } from "@/components/DestinationCombobox";
import { PassengerStepper, type PassengerCounts } from "@/components/PassengerStepper";
import { CompanionPicker } from "@/components/CompanionPicker";
import { TripShapeControl, type TripShapeValue } from "@/components/TripShapeControl";
import { useDepartmentMembers } from "@/features/auth/useDepartmentMembers";
import { useDestinations } from "@/features/fleet/hooks";
import { useDepartmentSettings, useWeekRow } from "@/features/sadran/hooks";
import { TZ } from "@/lib/time";
import { TimeField15 } from "@/components/TimeField15";
import { isSlotFree, type CarFreeWindow } from "@/features/siddur/freeWindows";
import { siddurKeys } from "@/features/siddur/queryKeys";
import { he, t, tv } from "@/i18n/he";

import { endTimeForDuration, QUICK_REQUEST_DURATION_HOURS, type QuickRequestDuration } from "../duration";
import { coverNamedPassengers, guestPassengerNames, quickVehicleWindow } from "../quickRequest";
import { toInstant } from "../mapper";
import { useSubmitRequestMutation } from "../hooks";
import type { SubmitRequestPayload, SubmitRequestResult } from "../api";

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

export interface QuickRequestSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  departmentId: string;
  weekStart: string;
  rideTypeId: string;
  /** `yyyy-MM-dd`, the day the slot/button belongs to. */
  day: string;
  /** "HH:MM", prefilled start (still editable). */
  initialStartTime: string;
  /** The car the sheet opened for — the row clicked, or the day-list's "next free" default. */
  initialCarId: string;
  /** Every shared car in the department, for the "another car is free" offer and the optional picker. */
  cars: readonly QuickRequestCarOption[];
  /** For the destination field (same catalog `RequestForm` uses). */
  destinations: readonly DestinationPreset[];
  /** Phone "לוקח/ת רכב עכשיו" flow: lets the member change which car they're asking for. */
  showCarPicker?: boolean;
  /** Pre-computed per-car free windows for `day`'s displayed range (`features/siddur/freeWindows.ts`). */
  freeWindows: readonly CarFreeWindow[];
  /** Raw away-from-home windows, for the more specific "away" warning (a subset of what's already excluded from `freeWindows`). */
  awayWindows?: readonly QuickRequestAwayWindow[];
  now: Date;
}

interface QuickRequestState {
  carId: string;
  startTime: string;
  duration: QuickRequestDuration;
  customEndTime: string;
  destination: DestinationValue | null;
  passengers: PassengerCounts;
  passengersExpanded: boolean;
  tripShape: TripShapeValue;
  rideDescription: string;
  companionIds: string[];
  guestNames: string;
}

function buildInitialState(carId: string, startTime: string): QuickRequestState {
  return {
    carId,
    startTime,
    duration: 2,
    customEndTime: endTimeForDuration(startTime, 2).time,
    destination: null,
    passengers: { adults: 1, childSeats: 0, boosters: 0 },
    passengersExpanded: false,
    tripShape: "round_trip",
    rideDescription: "",
    companionIds: [],
    guestNames: "",
  };
}

function dayLabel(dateStr: string): string {
  const parsed = parseISO(dateStr);
  return `${he.days.short[getDay(parsed)]} ${format(parsed, "dd.MM")}`;
}

const DURATION_HOUR_LABELS: Record<1 | 2 | 3 | 4, string> = {
  1: t("quickRequest.duration1h"),
  2: t("quickRequest.duration2h"),
  3: t("quickRequest.duration3h"),
  4: t("quickRequest.duration4h"),
};

function passengersSummary(passengers: PassengerCounts): string {
  const extra = passengers.childSeats + passengers.boosters;
  return extra > 0
    ? `${tv("quickRequest.passengersSummary", { count: String(passengers.adults) })} + ${extra}`
    : tv("quickRequest.passengersSummary", { count: String(passengers.adults) });
}

/**
 * Compact "I'm taking this car" sheet (UX_FLOWS.md §18): opened from an empty grid cell on
 * the live-week siddur, the day list's "לוקח/ת רכב עכשיו" button/free-gap rows, and Home's
 * quick-request card. One primary action; duration chips instead of a full return-time field;
 * passenger details collapsed by default, with public ride description. Submits through the same `submit_request` RPC as the
 * full request form (`preferred_car_id` set), so the server remains the sole authority on
 * whether the car is actually free — the client-side `freeWindows` check here is only a
 * pre-validation hint (overlap/away warnings, past-slot disable), never a hard gate that could
 * drift from the RPC's own logic.
 */
export function QuickRequestSheet({
  open,
  onOpenChange,
  departmentId,
  weekStart,
  rideTypeId,
  day,
  initialStartTime,
  initialCarId,
  cars,
  destinations,
  showCarPicker,
  freeWindows,
  awayWindows = [],
  now,
}: QuickRequestSheetProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const submitMutation = useSubmitRequestMutation();
  const membersQuery = useDepartmentMembers(departmentId);
  const destinationsQuery = useDestinations();
  const settingsQuery = useDepartmentSettings(departmentId);
  const weekQuery = useWeekRow(departmentId, weekStart);

  const initKey = `${initialCarId}:${day}:${initialStartTime}`;
  const [state, setState] = useState<QuickRequestState>(() => buildInitialState(initialCarId, initialStartTime));
  const [appliedInitKey, setAppliedInitKey] = useState(initKey);
  if (open && initKey !== appliedInitKey) {
    setState(buildInitialState(initialCarId, initialStartTime));
    setAppliedInitKey(initKey);
  }

  const [submitError, setSubmitError] = useState<string | null>(null);

  const car = cars.find((c) => c.id === state.carId) ?? null;
  const durationEnd = state.duration === "custom" ? { time: state.customEndTime, nextDay: false } : endTimeForDuration(state.startTime, state.duration);

  const departAtIso = toInstant(day, state.startTime, false);
  const returnAtIso = toInstant(day, durationEnd.time, durationEnd.nextDay);
  const oneWay = state.tripShape !== "round_trip";
  const destinationId = state.destination && "presetId" in state.destination ? state.destination.presetId : undefined;
  const travelMinutes = destinationsQuery.data?.find((d) => d.id === destinationId)?.travel_minutes ?? 30;
  const overrides = weekQuery.data?.settings_overrides;
  const overrideDwell = overrides && typeof overrides === "object" && !Array.isArray(overrides) ? overrides.chauffeur_dwell_minutes : undefined;
  const dwellMinutes = typeof overrideDwell === "number" ? overrideDwell : settingsQuery.data?.chauffeur_dwell_minutes ?? 10;
  const { startMs, endMs } = quickVehicleWindow(state.tripShape, Date.parse(departAtIso), Date.parse(returnAtIso), travelMinutes, dwellMinutes);
  const guests = guestPassengerNames(state.guestNames);
  const tooManyNames = state.companionIds.length + guests.length + 1 > state.passengers.adults + state.passengers.childSeats + state.passengers.boosters;
  const invalidGuestNames = guests.length > 20 || guests.some((name) => name.length > 100);
  const outsideDay = startMs < Date.parse(toInstant(day, "00:00", false)) || endMs > Date.parse(toInstant(day, "23:59", false));
  const invalidTime = endMs <= startMs || outsideDay;

  function setNamedPassengers(companionIds: string[], guestNames: string) {
    setState((s) => ({ ...s, companionIds, guestNames, passengers: coverNamedPassengers(s.passengers, companionIds.length + guestPassengerNames(guestNames).length) }));
  }

  const isPast = startMs < now.getTime();
  const carIsFree = isSlotFree(freeWindows, state.carId, startMs, endMs);
  const isAway =
    !carIsFree &&
    awayWindows.some(
      (w) =>
        w.carId === state.carId &&
        startMs < (w.awayUntil ? Date.parse(w.awayUntil) : Infinity) &&
        Date.parse(w.awayFrom) < endMs,
    );
  const otherFreeCar = !carIsFree ? cars.find((c) => c.id !== state.carId && isSlotFree(freeWindows, c.id, startMs, endMs)) : undefined;

  async function handleSubmit() {
    if (!state.destination || isPast || invalidTime || tooManyNames || invalidGuestNames) return;
    setSubmitError(null);

    const payload: SubmitRequestPayload = {
      department_id: departmentId,
      week_start: weekStart,
      destination_id: "presetId" in state.destination ? state.destination.presetId : undefined,
      destination_text: "freeText" in state.destination ? state.destination.freeText : undefined,
      ride_type_id: rideTypeId,
      trip_shape: state.tripShape,
      depart_at: state.tripShape === "one_way_from" ? undefined : departAtIso,
      return_at: state.tripShape === "one_way_from" ? departAtIso : state.tripShape === "round_trip" ? returnAtIso : undefined,
      adults: state.passengers.adults,
      child_seats: state.passengers.childSeats,
      boosters: state.passengers.boosters,
      needs_car_at_destination: !oneWay,
      one_way_car_mode: oneWay ? "passenger" : undefined,
      reserve_missing_driver: oneWay || undefined,
      ride_description: state.rideDescription.trim() || null,
      companion_ids: state.companionIds,
      guest_passenger_names: guests,
      preferred_car_id: state.carId,
    };

    try {
      const raw = await submitMutation.mutateAsync(payload);
      const result = raw as unknown as SubmitRequestResult;
      queryClient.invalidateQueries({ queryKey: siddurKeys.boardRides(departmentId, weekStart) });
      queryClient.invalidateQueries({ queryKey: siddurKeys.carLocations(departmentId, weekStart) });

      if (result.needs_driver && result.ride_id && result.car_id) {
        toast.success(tv("quickRequest.successNeedsDriver", { car: cars.find((c) => c.id === result.car_id)?.name ?? "" }));
      } else if (result.status === "assigned" && result.car_id) {
        const assignedCarName = cars.find((c) => c.id === result.car_id)?.name ?? "";
        if (result.car_id === state.carId) {
          toast.success(tv("quickRequest.successAssigned", { car: assignedCarName, start: state.startTime, end: durationEnd.time }));
        } else {
          toast.success(tv("quickRequest.successFallback", { car: assignedCarName, preferredCar: car?.name ?? "" }));
        }
      } else {
        toast(t("quickRequest.waitlisted"), {
          action: { label: t("quickRequest.waitlistedLink"), onClick: () => navigate("/requests") },
        });
      }
      onOpenChange(false);
    } catch {
      setSubmitError(t("quickRequest.submitError"));
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>
            {oneWay ? tv("quickRequest.oneWayHeader", { day: dayLabel(day), start: state.startTime }) : car
              ? tv("quickRequest.header", { car: car.name, day: dayLabel(day), start: state.startTime })
              : tv("quickRequest.headerNoCar", { day: dayLabel(day), start: state.startTime })}
          </SheetTitle>
        </SheetHeader>

        <div className="space-y-5 py-4">
          {showCarPicker ? (
            <div className="space-y-1.5">
              <Label>{t("quickRequest.carPickerLabel")}</Label>
              <Select value={state.carId} onValueChange={(next) => setState((s) => ({ ...s, carId: next }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {cars.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label>{t("field.destination")}</Label>
            <DestinationCombobox
              destinations={destinations}
              value={state.destination}
              onChange={(next) => setState((s) => ({ ...s, destination: next }))}
              autoFocus
            />
          </div>

          <TripShapeControl value={state.tripShape} onChange={(tripShape) => setState((s) => ({ ...s, tripShape }))} />
          {oneWay ? <p className="text-sm text-destructive">{t("quickRequest.oneWayHelp")}</p> : null}

          {!oneWay ? <div className="space-y-1.5">
            <Label>{t("quickRequest.duration")}</Label>
            <ToggleGroup
              type="single"
              value={String(state.duration)}
              onValueChange={(next) => {
                if (!next) return;
                setState((s) => ({ ...s, duration: next === "custom" ? "custom" : (Number(next) as 1 | 2 | 3 | 4) }));
              }}
              className="flex-wrap justify-start"
              aria-label={t("quickRequest.duration")}
            >
              {QUICK_REQUEST_DURATION_HOURS.map((h) => (
                <ToggleGroupItem key={h} value={String(h)} className="h-11 px-3 text-sm">
                  {DURATION_HOUR_LABELS[h]}
                </ToggleGroupItem>
              ))}
              <ToggleGroupItem value="custom" className="h-11 px-3 text-sm">
                {t("quickRequest.durationCustom")}
              </ToggleGroupItem>
            </ToggleGroup>
          </div> : null}

          <div className="flex gap-4">
            <div className="flex-1 space-y-1.5">
              <Label>{state.tripShape === "one_way_from" ? t("field.return") : t("field.depart")}</Label>
              <TimeField15
                min="06:00"
                max={state.tripShape === "one_way_from" ? "23:59" : "23:45"}
                value={state.startTime}
                onChange={(next) => setState((s) => ({ ...s, startTime: next }))}
                aria-label={state.tripShape === "one_way_from" ? t("field.return") : t("field.depart")}
              />
            </div>
            {!oneWay && (state.duration === "custom" ? (
              <div className="flex-1 space-y-1.5">
                <Label>{t("field.return")}</Label>
                <TimeField15
                  value={state.customEndTime}
                  min={state.startTime}
                  max="23:59"
                  onChange={(next) => setState((s) => ({ ...s, customEndTime: next }))}
                  aria-label={t("field.return")}
                />
              </div>
            ) : (
              <div className="flex-1 space-y-1.5">
                <Label>{t("field.return")}</Label>
                <p className="flex h-9 items-center text-sm text-muted-foreground" dir="ltr">
                  {durationEnd.time}
                </p>
              </div>
            ))}
          </div>
          {state.tripShape === "one_way_from" ? <p className="text-xs text-muted-foreground">{t("quickRequest.arrivalHomeHelp")}</p> : null}
          {oneWay ? <p className="text-xs text-muted-foreground">{tv("quickRequest.vehicleWindow", { start: formatInTimeZone(startMs, TZ, "HH:mm"), end: formatInTimeZone(endMs, TZ, "HH:mm") })}</p> : null}

          {!carIsFree ? (
            <div className="space-y-1.5 rounded-md border-s-4 border-amber-500 bg-amber-50 p-3 text-sm text-amber-900">
              <p>{isAway ? t("quickRequest.awayWarning") : t("quickRequest.overlapWarning")}</p>
              {otherFreeCar ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setState((s) => ({ ...s, carId: otherFreeCar.id }))}
                >
                  {tv("quickRequest.overlapOfferOtherCar", { car: otherFreeCar.name })}
                </Button>
              ) : (
                <p className="text-xs">{t("quickRequest.noCarFree")}</p>
              )}
            </div>
          ) : null}

          <div className="space-y-1.5">
            {state.passengersExpanded ? (
              <>
                <Label>{t("field.passengers")}</Label>
                <PassengerStepper
                  value={state.passengers}
                  onChange={(next) => setState((s) => ({ ...s, passengers: next }))}
                />
                <p className="text-xs text-muted-foreground">{t("quickRequest.passengersCountHelp")}</p>
                <CompanionPicker members={membersQuery.data ?? []} value={state.companionIds} onChange={(ids) => setNamedPassengers(ids, state.guestNames)} />
                <Label htmlFor="quick-guests">{t("quickRequest.guestPassengers")}</Label>
                <Textarea id="quick-guests" value={state.guestNames} onChange={(e) => setNamedPassengers(state.companionIds, e.target.value)} rows={2} />
                <p className="text-xs text-muted-foreground">{t("quickRequest.guestPassengersHelp")}</p>
              </>
            ) : (
              <button
                type="button"
                className="text-sm text-muted-foreground underline"
                onClick={() => setState((s) => ({ ...s, passengersExpanded: true }))}
              >
                {passengersSummary(state.passengers)} · {t("quickRequest.passengersExpand")}
              </button>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="quick-description">{t("quickRequest.rideDescription")}</Label>
            <Textarea id="quick-description" value={state.rideDescription} onChange={(e) => setState((s) => ({ ...s, rideDescription: e.target.value }))} maxLength={1000} rows={2} />
            <p className="text-xs text-muted-foreground">{t("quickRequest.rideDescriptionHelp")}</p>
          </div>
          {tooManyNames ? <p role="alert" className="text-sm text-destructive">{t("quickRequest.namesExceedSeats")}</p> : null}
          {invalidGuestNames ? <p role="alert" className="text-sm text-destructive">{t("quickRequest.invalidGuestNames")}</p> : null}
          {invalidTime ? <p role="alert" className="text-sm text-destructive">{outsideDay ? he.sadranProposal.sameDayOnly : he.rideEditing.invalidTime}</p> : null}

          {submitError ? <p className="text-sm text-destructive">{submitError}</p> : null}

          <Button
            type="button"
            className="w-full"
            size="lg"
            disabled={!state.destination || isPast || invalidTime || tooManyNames || invalidGuestNames || submitMutation.isPending}
            title={isPast ? t("quickRequest.pastSlotTooltip") : undefined}
            onClick={() => void handleSubmit()}
          >
            {oneWay ? t("quickRequest.submitOneWay") : t("quickRequest.submit")}
          </Button>
          {isPast ? <p className="text-xs text-destructive">{t("quickRequest.pastSlotTooltip")}</p> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
