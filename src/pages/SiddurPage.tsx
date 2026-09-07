import { formatInTimeZone } from "date-fns-tz";
import { CalendarDays, Inbox } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { formatWeekRangeLabel, todayInJerusalem } from "@/components/DateField";
import { DestinationCombobox, type DestinationValue } from "@/components/DestinationCombobox";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { RideCard, type RideCardData } from "@/components/RideCard";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatMinutes } from "@/components/TimeField15";
import { WeekGrid, type WeekGridCar, type WeekGridRide } from "@/components/WeekGrid";
import { WeekStrip } from "@/components/WeekStrip";
import { useMyDepartments } from "@/features/auth/useMyDepartments";
import { useProfile } from "@/features/auth/useProfile";
import { useSession } from "@/features/auth/useSession";
import { useCars, useDestinations, useRideTypes } from "@/features/fleet/hooks";
import { QuickRequestSheet } from "@/features/requests/components/QuickRequestSheet";
import { RideDetailSheet } from "@/features/siddur/components/RideDetailSheet";
import { groupByDay } from "@/features/siddur/dayGrouping";
import { firstCarFreeNow, roundUpToQuarterHour } from "@/features/siddur/freeWindows";
import {
  useBoardRides,
  useBoardStartTime,
  useCarLocations,
  useDepartments,
  useWeeks,
} from "@/features/siddur/hooks";
import { useDayFreeWindows } from "@/features/siddur/useDayFreeWindows";
import type { Week } from "@/features/siddur/api";
import { servedOf } from "@/features/sadran/solverRun";
import { rideBlockLabel, resolveRideRealDestination } from "@/lib/rideLabel";
import { parseTimeToMinutes } from "@/features/solverBridge/buildSolverInput";
import { he, t, tv } from "@/i18n/he";
import { TZ } from "@/lib/time";

/** Live > Published/Archived > soonest Open (UX_FLOWS §3.5: the siddur opens on the relevant week). */
function resolveSiddurWeek(weeks: readonly Week[]): Week | null {
  const live = weeks.find((w) => w.phase === "live");
  if (live) return live;
  const published = [...weeks]
    .filter((w) => w.phase === "published" || w.phase === "archived")
    .sort((a, b) => (a.week_start < b.week_start ? 1 : -1))[0];
  if (published) return published;
  const open = [...weeks].filter((w) => w.phase === "open").sort((a, b) => (a.week_start < b.week_start ? -1 : 1))[0];
  return open ?? null;
}

function minutesSinceMidnight(instant: string): number {
  const [h, m] = formatInTimeZone(new Date(instant), TZ, "HH:mm").split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * `/siddur`, `/siddur/:dept/:week` — published siddur (UX_FLOWS.md §3.5). Day
 * list by default; a read-only `WeekGrid` from `lg` up. Members read other
 * departments' published siddurim too (REQ §13.52) — the department switcher
 * lists every active department, and RLS naturally empties out anything not
 * visible (draft/open weeks of a department I don't belong to).
 */
export function SiddurPage() {
  const params = useParams<{ dept?: string; week?: string }>();
  const navigate = useNavigate();

  const { session } = useSession();
  const profileId = session?.user.id;
  const profileQuery = useProfile();
  const myDepartmentsQuery = useMyDepartments();
  const departmentsQuery = useDepartments();
  const destinationsQuery = useDestinations();

  const defaultDepartmentId =
    profileQuery.data?.default_department_id ?? myDepartmentsQuery.data?.[0]?.department_id;
  const departmentId = params.dept ?? defaultDepartmentId;

  const weeksQuery = useWeeks(departmentId);
  const weeks = weeksQuery.data ?? [];
  const resolvedWeek = params.week ? weeks.find((w) => w.week_start === params.week) ?? null : resolveSiddurWeek(weeks);
  const weekStart = resolvedWeek?.week_start;

  const boardRidesQuery = useBoardRides(departmentId, weekStart);
  const carsQuery = useCars(departmentId);
  const carLocationsQuery = useCarLocations(departmentId, weekStart);
  const boardStartTimeQuery = useBoardStartTime(departmentId);
  const rideTypesQuery = useRideTypes();

  const [destFilter, setDestFilter] = useState<DestinationValue | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [selectedRideId, setSelectedRideId] = useState<string | null>(null);
  const [quickRequestSlot, setQuickRequestSlot] = useState<{
    carId: string;
    day: string;
    time: string;
    showCarPicker?: boolean;
  } | null>(null);
  // Vertical-board redesign (UX_FLOWS.md §20): same visible-range default as
  // the Sadran board — `department_settings.board_start_time` if set, else
  // 06:00, expandable down to 00:00 via "הצג שעות מוקדמות".
  const [showEarlyHours, setShowEarlyHours] = useState(false);
  const boardStartMinutes = boardStartTimeQuery.data ? parseTimeToMinutes(boardStartTimeQuery.data) : 6 * 60;
  const dayStartMinutes = showEarlyHours ? 0 : boardStartMinutes;
  const dayEndMinutes = 24 * 60;

  const isMyDepartment = (myDepartmentsQuery.data ?? []).some((d) => d.department_id === departmentId);
  const filterName = destFilter ? ("presetId" in destFilter ? destFilter.name : destFilter.freeText) : null;
  const homeDestinationId = (departmentsQuery.data ?? []).find((d) => d.id === departmentId)?.home_destination_id ?? null;

  const rides = (boardRidesQuery.data ?? []).filter(
    (r) => !filterName || r.destination_name === filterName || r.origin_name === filterName,
  );

  const dayGroups = weekStart ? groupByDay(rides, weekStart, (r) => r.starts_at ?? "") : [];
  const today = todayInJerusalem();
  const defaultDay = dayGroups.find((g) => g.date === today)?.date ?? dayGroups[0]?.date ?? null;
  const activeDay = selectedDay ?? defaultDay;
  const activeDayRides = dayGroups.find((g) => g.date === activeDay)?.items ?? [];

  // Quick-request-from-empty-slot (UX_FLOWS.md §18): only the live week auto-approves onto a
  // specific car (REQ §8) — an Open/Solving week has no car to target yet, the Sadran solves
  // later, so a click there just prefills the normal form's day/time instead (below).
  const isLiveWeek = resolvedWeek?.phase === "live";
  const now = new Date();
  const dayFreeWindows = useDayFreeWindows(departmentId, isLiveWeek ? weekStart : undefined, isLiveWeek ? (activeDay ?? undefined) : undefined, now);
  const defaultRideTypeId = rideTypesQuery.data?.find((rt) => rt.code === "other")?.id ?? rideTypesQuery.data?.[0]?.id ?? "";

  function handleSlotClick(carId: string, minutes: number) {
    if (!weekStart || !activeDay) return;
    const time = formatMinutes(minutes);
    if (isLiveWeek) {
      setQuickRequestSlot({ carId, day: activeDay, time });
    } else {
      navigate(`/requests/new?week=${weekStart}&day=${activeDay}&time=${time}`);
    }
  }

  function handleTakeCarNow() {
    if (!activeDay) return;
    const nowRounded = roundUpToQuarterHour(now.getTime());
    const time = formatInTimeZone(new Date(nowRounded), TZ, "HH:mm");
    const carId = firstCarFreeNow(dayFreeWindows.freeWindows, now.getTime())?.carId ?? dayFreeWindows.cars[0]?.id;
    if (!carId) return;
    setQuickRequestSlot({ carId, day: activeDay, time, showCarPicker: true });
  }

  /** Free gaps ≥ 1h per car, tappable rows in the phone day list (UX_FLOWS.md §18). */
  const freeGapRows = isLiveWeek
    ? dayFreeWindows.freeWindows
        .filter((w) => w.end - w.start >= 60 * 60_000)
        .map((w) => ({
          ...w,
          carName: dayFreeWindows.cars.find((c) => c.id === w.carId)?.name ?? "",
          startTime: formatInTimeZone(new Date(w.start), TZ, "HH:mm"),
          endTime: formatInTimeZone(new Date(w.end), TZ, "HH:mm"),
        }))
        .sort((a, b) => a.start - b.start)
    : [];

  const selectedRide = rides.find((r) => r.id === selectedRideId) ?? null;
  const selectedCar = selectedRide ? (carsQuery.data ?? []).find((c) => c.id === selectedRide.car_id) ?? null : null;
  const selectedLocation = selectedRide
    ? carLocationsQuery.data?.find((l) => l.car_id === selectedRide.car_id)?.location_name ?? null
    : null;

  const weekGridCars: WeekGridCar[] = useMemo(
    () =>
      (carsQuery.data ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        group: c.type,
        locationBadge: carLocationsQuery.data?.find((l) => l.car_id === c.id)?.location_name ?? undefined,
      })),
    [carsQuery.data, carLocationsQuery.data],
  );
  // Not memoized: `activeDayRides` is a freshly derived array each render (it comes from
  // `.find(...)?.items`), so a `useMemo` here would never skip recomputation anyway — the
  // mapping itself is cheap (one day's rides, a handful of rows).
  // Owner-reported bug (UX_FLOWS.md §20): the member grid showed the
  // department's own name ("נבו") instead of the real destination for a
  // round trip, same root cause the Sadran board already fixed for itself
  // (`rideBlockLabel`, DATA_MODEL.md consistency decision #14) — just never
  // wired into this screen. `v_board_rides.served` already carries the real
  // per-request destination + requester name (RLS permits any approved
  // member to read it for a published week, REQUIREMENTS §10).
  const weekGridRides: WeekGridRide[] = activeDayRides
    .filter((r) => r.car_id && r.starts_at && r.ends_at)
    .map((r) => ({
      id: r.id as string,
      carId: r.car_id as string,
      startMinutes: minutesSinceMidnight(r.starts_at as string),
      endMinutes: minutesSinceMidnight(r.ends_at as string),
      label:
        homeDestinationId && r.origin_id && r.destination_id
          ? rideBlockLabel({
              originId: r.origin_id,
              destinationId: r.destination_id,
              originName: r.origin_name ?? "",
              destinationName: r.destination_name ?? "",
              homeDestinationId,
              served: servedOf(r),
            })
          : (r.destination_name ?? ""),
    }));

  function goTo(nextDept: string, nextWeek: string | undefined) {
    navigate(nextWeek ? `/siddur/${nextDept}/${nextWeek}` : "/siddur");
  }

  const dayCounts = dayGroups.map((g) => ({ rides: g.items.length, unmet: 0 }));

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 pb-24">
      <PageHeader
        title={t("screen.siddur.title")}
        subtitle={weekStart ? formatWeekRangeLabel(weekStart) : undefined}
        actions={
          (myDepartmentsQuery.data?.length ?? 0) > 1 || (departmentsQuery.data?.length ?? 0) > 1 ? (
            <Select
              value={departmentId}
              onValueChange={(next) => goTo(next, undefined)}
            >
              <SelectTrigger className="w-40">
                <SelectValue placeholder={he.siddur.departmentSwitcher} />
              </SelectTrigger>
              <SelectContent>
                {(departmentsQuery.data ?? []).map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : undefined
        }
      />

      {!isMyDepartment ? <p className="text-xs text-muted-foreground">{he.siddur.otherDeptNote}</p> : null}

      {weeks.length > 1 ? (
        <div className="flex items-center gap-2 overflow-x-auto">
          {weeks.map((w) => (
            <button
              key={w.week_start}
              type="button"
              onClick={() => goTo(departmentId as string, w.week_start)}
              className={
                "shrink-0 rounded-md border px-2 py-1 text-xs " +
                (w.week_start === weekStart ? "border-primary bg-primary/10" : "border-input")
              }
            >
              <span dir="ltr">{formatWeekRangeLabel(w.week_start)}</span> · {he.phase[w.phase]}
            </button>
          ))}
        </div>
      ) : null}

      {!resolvedWeek ? (
        <EmptyState icon={CalendarDays} message={he.requestsList.empty} />
      ) : resolvedWeek.phase === "open" || resolvedWeek.phase === "solving" ? (
        <EmptyState
          icon={Inbox}
          message={tv("siddur.notPublishedYet", { weekLabel: formatWeekRangeLabel(resolvedWeek.week_start) })}
          action={
            <a href="/requests" className="text-sm font-medium text-primary underline">
              {he.siddur.notPublishedAction}
            </a>
          }
        />
      ) : (
        <>
          <DestinationCombobox
            destinations={(destinationsQuery.data ?? []).map((d) => ({
              id: d.id,
              name: d.name,
              aliases: d.aliases,
              zone: d.zone,
            }))}
            value={destFilter}
            mode="filter"
            onChange={setDestFilter}
          />

          <div className="lg:hidden">
            <WeekStrip weekStart={weekStart as string} counts={dayCounts} selected={activeDay ?? ""} onSelect={setSelectedDay} />
            <div className="mt-3 space-y-2">
              {isMyDepartment && isLiveWeek ? (
                <Button type="button" variant="outline" className="w-full" onClick={handleTakeCarNow}>
                  {t("quickRequest.takeCarNow")}
                </Button>
              ) : null}
              {filterName && activeDayRides.length === 0 ? (
                <EmptyState
                  icon={CalendarDays}
                  message={tv("siddur.filterEmpty", { destination: filterName })}
                />
              ) : activeDayRides.length === 0 && freeGapRows.length === 0 ? (
                <EmptyState icon={CalendarDays} message={he.siddur.noRides} />
              ) : (
                activeDayRides.map((r) => {
                  // Same fix as `weekGridRides` above (UX_FLOWS §20): a round trip's own
                  // `destination_name` is always the department's home name.
                  const destinationName =
                    homeDestinationId && r.origin_id && r.destination_id
                      ? resolveRideRealDestination({
                          originId: r.origin_id,
                          destinationId: r.destination_id,
                          originName: r.origin_name ?? "",
                          destinationName: r.destination_name ?? "",
                          homeDestinationId,
                          served: servedOf(r),
                        })
                      : (r.destination_name ?? "");
                  const data: RideCardData = {
                    id: r.id as string,
                    startsAt: r.starts_at as string,
                    endsAt: r.ends_at,
                    originName: r.origin_name ?? "",
                    destinationName,
                    driverName: r.driver_name,
                    isChauffeur: !!r.is_chauffeur,
                    carName: (carsQuery.data ?? []).find((c) => c.id === r.car_id)?.name ?? null,
                    carType: (carsQuery.data ?? []).find((c) => c.id === r.car_id)?.type,
                  };
                  return <RideCard key={r.id} ride={data} onClick={() => setSelectedRideId(r.id as string)} />;
                })
              )}
              {isMyDepartment
                ? freeGapRows.map((gap) => (
                    <button
                      key={`${gap.carId}-${gap.start}`}
                      type="button"
                      className="w-full rounded-md border border-dashed p-3 text-start text-sm text-muted-foreground hover:bg-accent/40"
                      onClick={() => setQuickRequestSlot({ carId: gap.carId, day: activeDay as string, time: gap.startTime })}
                    >
                      <span dir="ltr">{tv("quickRequest.freeGapRow", { start: gap.startTime, end: gap.endTime })}</span>
                      {" · "}
                      {gap.carName}
                    </button>
                  ))
                : null}
            </div>
          </div>

          <div className="hidden lg:block">
            <div className="flex items-center justify-between gap-2">
              <WeekStrip weekStart={weekStart as string} counts={dayCounts} selected={activeDay ?? ""} onSelect={setSelectedDay} />
              <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setShowEarlyHours((v) => !v)}>
                {showEarlyHours ? he.board.hideEarlyHours : he.board.showEarlyHours}
              </Button>
            </div>
            <div className="mt-3">
              <WeekGrid
                cars={weekGridCars}
                rides={weekGridRides}
                dayStartMinutes={dayStartMinutes}
                dayEndMinutes={dayEndMinutes}
                readOnly
                onRideClick={setSelectedRideId}
                onSlotClick={isMyDepartment ? handleSlotClick : undefined}
              />
            </div>
          </div>
        </>
      )}

      <RideDetailSheet
        ride={selectedRide}
        car={selectedCar}
        locationBadge={selectedLocation}
        homeDestinationId={homeDestinationId}
        onOpenChange={(open) => !open && setSelectedRideId(null)}
        onAskToJoin={() => selectedRide && navigate(`/requests/new?ride=${selectedRide.id}`)}
        showAskToJoin={!!selectedRide && isMyDepartment && selectedRide.driver_id !== profileId}
      />

      {isMyDepartment ? (
        <a
          href="/requests/new"
          className="fixed bottom-20 end-4 z-30 flex size-14 items-center justify-center rounded-full bg-primary text-2xl text-primary-foreground shadow-lg md:bottom-6"
          aria-label={t("action.newRequest")}
        >
          +
        </a>
      ) : null}

      {quickRequestSlot && weekStart ? (
        <QuickRequestSheet
          open={!!quickRequestSlot}
          onOpenChange={(open) => !open && setQuickRequestSlot(null)}
          departmentId={departmentId as string}
          weekStart={weekStart}
          rideTypeId={defaultRideTypeId}
          day={quickRequestSlot.day}
          initialStartTime={quickRequestSlot.time}
          initialCarId={quickRequestSlot.carId}
          showCarPicker={quickRequestSlot.showCarPicker}
          cars={dayFreeWindows.cars}
          destinations={(destinationsQuery.data ?? []).map((d) => ({
            id: d.id,
            name: d.name,
            aliases: d.aliases,
            zone: d.zone,
          }))}
          freeWindows={dayFreeWindows.freeWindows}
          awayWindows={dayFreeWindows.awayWindows}
          now={now}
        />
      ) : null}
    </div>
  );
}
