// REQ item 246 (LT1): the request form's route through the one timing rule — the stops editor shows
// each place's hour from it, and the form keeps the car's derived times wide enough for it.
import { useMemo } from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";

import type { DestinationValue } from "@/components/DestinationCombobox";
import type { StopAnchor } from "@/lib/stopSchedule";

import { useDepartmentSettings } from "@/features/sadran/hooks";

import { timeToMinutes } from "../../duration";
import { useRouteHopsQuery } from "../../routeHopsQuery";
import type { FlexValue } from "../../mapper";
import type { RequestFormValues } from "../../schema";
import { rushWindowsForDay, travelMarginOf } from "../../rushHours";
import { formDriveRule, scheduleOfRoute, stopRoutePoints, type StopHoursRecord, type StopRouteValues } from "../../stopHours";

const hasPlace = (v: DestinationValue | null | undefined): v is DestinationValue =>
  !!v && ("presetId" in v ? !!v.presetId : v.freeText.trim() !== "");

export function useStopSchedule(form: UseFormReturn<RequestFormValues>, hasReturn: boolean, enabled = true) {
  const watched = useWatch({
    control: form.control,
    name: ["departmentId", "day", "origin", "destination", "outStops", "returnStops", "stopHours", "departAnchor", "departTime",
      "arriveByTime", "flexDepartLate", "returnAnchor", "returnTime", "leaveDestTime", "flexReturnLate"],
  });
  const [departmentId, day, origin, destination, outStops, returnStops, stopHours, departAnchor, departTime,
    arriveByTime, flexDepartLate, returnAnchor, returnTime, leaveDestTime, flexReturnLate] = watched as [
    string, string | undefined, DestinationValue | null, DestinationValue | null, DestinationValue[] | undefined, DestinationValue[] | undefined,
    StopHoursRecord | undefined, StopAnchor | undefined, string | undefined, string | undefined, FlexValue | undefined,
    StopAnchor | undefined, string | undefined, string | undefined, FlexValue | undefined];

  const ready = hasPlace(destination);
  const values: StopRouteValues | null = useMemo(() => (ready ? {
    origin: hasPlace(origin) ? origin : { freeText: "" },
    destination: destination as DestinationValue,
    outStops: outStops ?? [],
    returnStops: returnStops ?? [],
    stopHours,
    hasReturn,
    departAnchor: departAnchor ?? "leave",
    departTime, arriveByTime, flexDepartLate,
    returnAnchor: returnAnchor ?? "arrive",
    returnTime, leaveDestTime, flexReturnLate,
  } : null), [ready, origin, destination, outStops, returnStops, stopHours, hasReturn, departAnchor, departTime, arriveByTime,
    flexDepartLate, returnAnchor, returnTime, leaveDestTime, flexReturnLate]);

  const route = useMemo(() => (values ? stopRoutePoints(values) : null), [values]);
  const hopsQuery = useRouteHopsQuery(departmentId, route?.preview ?? [], enabled && !!route);
  const hops = hopsQuery.data && route && hopsQuery.data.hops.length === route.points.length - 1 ? hopsQuery.data : null;
  const defaultStart = departTime ? timeToMinutes(departTime) : 8 * 60;
  // REQ item 249 (b)/(c): every drive counts the department's margin and the day's rush hours.
  const settings = useDepartmentSettings(departmentId).data;
  const drive = useMemo(() => formDriveRule(rushWindowsForDay(settings, day), travelMarginOf(settings)), [settings, day]);
  const schedule = useMemo(
    () => (route && hops ? scheduleOfRoute(route.points, hops, defaultStart, drive) : null),
    [route, hops, defaultStart, drive],
  );
  return { departmentId, values, points: route?.points ?? [], hops, schedule, drive };
}
