import { format, getDay, parseISO } from "date-fns";
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
import { TimeField15 } from "@/components/TimeField15";
import { isSlotFree, type CarFreeWindow } from "@/features/siddur/freeWindows";
import { siddurKeys } from "@/features/siddur/queryKeys";
import { he, t, tv } from "@/i18n/he";

import { endTimeForDuration, QUICK_REQUEST_DURATION_HOURS, type QuickRequestDuration } from "../duration";
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
  notes: string;
  notesExpanded: boolean;
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
    notes: "",
    notesExpanded: false,
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
 * passengers/notes collapsed by default. Submits through the same `submit_request` RPC as the
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
  const startMs = Date.parse(departAtIso);
  const endMs = Date.parse(returnAtIso);

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
    if (!state.destination || isPast) return;
    setSubmitError(null);

    const payload: SubmitRequestPayload = {
      department_id: departmentId,
      week_start: weekStart,
      destination_id: "presetId" in state.destination ? state.destination.presetId : undefined,
      destination_text: "freeText" in state.destination ? state.destination.freeText : undefined,
      ride_type_id: rideTypeId,
      trip_shape: "round_trip",
      depart_at: departAtIso,
      return_at: returnAtIso,
      adults: state.passengers.adults,
      child_seats: state.passengers.childSeats,
      boosters: state.passengers.boosters,
      needs_car_at_destination: true,
      notes: state.notes.trim() || undefined,
      preferred_car_id: state.carId,
    };

    try {
      const raw = await submitMutation.mutateAsync(payload);
      const result = raw as unknown as SubmitRequestResult;
      queryClient.invalidateQueries({ queryKey: siddurKeys.boardRides(departmentId, weekStart) });
      queryClient.invalidateQueries({ queryKey: siddurKeys.carLocations(departmentId, weekStart) });

      if (result.status === "assigned" && result.car_id) {
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
            {car
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

          <div className="space-y-1.5">
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
          </div>

          <div className="flex gap-4">
            <div className="flex-1 space-y-1.5">
              <Label>{t("field.depart")}</Label>
              <TimeField15
                value={state.startTime}
                onChange={(next) => setState((s) => ({ ...s, startTime: next }))}
                aria-label={t("field.depart")}
              />
            </div>
            {state.duration === "custom" ? (
              <div className="flex-1 space-y-1.5">
                <Label>{t("field.return")}</Label>
                <TimeField15
                  value={state.customEndTime}
                  min={state.startTime}
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
            )}
          </div>

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
            {state.notesExpanded ? (
              <>
                <Label>{t("field.notes")}</Label>
                <Textarea
                  value={state.notes}
                  onChange={(e) => setState((s) => ({ ...s, notes: e.target.value }))}
                  rows={2}
                />
              </>
            ) : (
              <button
                type="button"
                className="text-sm text-muted-foreground underline"
                onClick={() => setState((s) => ({ ...s, notesExpanded: true }))}
              >
                {t("quickRequest.notesExpand")}
              </button>
            )}
          </div>

          {submitError ? <p className="text-sm text-destructive">{submitError}</p> : null}

          <Button
            type="button"
            className="w-full"
            size="lg"
            disabled={!state.destination || isPast || submitMutation.isPending}
            title={isPast ? t("quickRequest.pastSlotTooltip") : undefined}
            onClick={() => void handleSubmit()}
          >
            {t("quickRequest.submit")}
          </Button>
          {isPast ? <p className="text-xs text-destructive">{t("quickRequest.pastSlotTooltip")}</p> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
