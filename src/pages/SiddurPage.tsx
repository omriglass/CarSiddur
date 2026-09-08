import { useProfile } from "@/features/auth/useProfile";
import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { TableViewControls } from "@/components/TableViewControls";
import { parseTimeToMinutes } from "@/features/solverBridge/buildSolverInput";
import { formatInTimeZone } from "date-fns-tz";
import { CalendarDays, Inbox } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { formatWeekRangeLabel, todayInJerusalem } from "@/components/DateField";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { RideCard, type RideCardData } from "@/components/RideCard";
import { RideTypeLegend } from "@/components/RideTypeLegend";
import { CardListSkeleton } from "@/components/skeletons/CardListSkeleton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
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
import { useSession } from "@/features/auth/useSession";
import { useIsSadran } from "@/features/auth/useIsSadran";
import { useMyRequests } from "@/features/requests/hooks";
import { useCars, useDestinations, useRideTypes, useMaintenanceBlocks, useCarSeatConfigs } from "@/features/fleet/hooks";
import { QuickRequestSheet } from "@/features/requests/components/QuickRequestSheet";
import { ridePublicDetails } from "@/lib/ridePublicDetails";
import { ridePassengerSummary } from "@/lib/ridePassengerSummary";
import { rideCoordinatorNotes } from "@/lib/rideCoordinatorNotes";
import { siddurCarName } from "@/lib/siddurCarName";
import { RideDetailSheet } from "@/features/siddur/components/RideDetailSheet";
import { MemberRideEditor } from "@/features/siddur/components/MemberRideEditor";
import { conflictingRides, moveOnRideDay } from "@/features/siddur/rideEditing";
import { tightScheduleRideIds } from "@/features/sadran/board/geometry";
import { useEditRideMutation, useDepartmentSettings, useWeekRequestsWithNames } from "@/features/sadran/hooks";
import { groupByDay } from "@/features/siddur/dayGrouping";
import { firstCarFreeNow, roundUpToQuarterHour } from "@/features/siddur/freeWindows";
import {
  useBoardRides,
  useCarLocations,
  useDepartments,
  useWeeks,
  useRideChanges,
  useRequestRideChangeMutation,
  useClaimRideDriverMutation,
} from "@/features/siddur/hooks";
import { useDayFreeWindows } from "@/features/siddur/useDayFreeWindows";
import type { Week, RideMove, BoardRide } from "@/features/siddur/api";
import { representativeRideTypeCode, servedOf } from "@/features/sadran/solverRun";
import { rideBlockLabel, resolveRideRealDestination } from "@/lib/rideLabel";
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
  const queryClient = useQueryClient();

  const { session } = useSession();
  const profileId = session?.user.id;
  const myDepartmentsQuery = useMyDepartments();
  const departmentsQuery = useDepartments();
  const active = useActiveDepartment();
  const profileQuery = useProfile();

  const defaultDepartmentId =
    active.departmentId;
  const departmentId = params.dept ?? defaultDepartmentId;
  const destinationsQuery = useDestinations(departmentId);

  const weeksQuery = useWeeks(departmentId);
  const weeks = weeksQuery.data ?? [];
  const resolvedWeek = params.week ? weeks.find((w) => w.week_start === params.week) ?? null : resolveSiddurWeek(weeks);
  const weekStart = resolvedWeek?.week_start;
  const { isSadran } = useIsSadran(departmentId, weekStart);
  const coordinatorRequestsQuery = useWeekRequestsWithNames(isSadran ? departmentId : undefined, weekStart);
  const myRequestsQuery = useMyRequests();
  const coordinatorRequests = isSadran ? coordinatorRequestsQuery.data ?? [] : [];

  const boardRidesQuery = useBoardRides(departmentId, weekStart);
  const carsQuery = useCars(departmentId);
  const maintenanceQuery = useMaintenanceBlocks(departmentId);
  const seatsQuery = useCarSeatConfigs(departmentId);
  const carLocationsQuery = useCarLocations(departmentId, weekStart);
  const rideTypesQuery = useRideTypes(departmentId);
  const settingsQuery = useDepartmentSettings(departmentId);
  const changesQuery = useRideChanges(departmentId, weekStart);
  const editMutation = useEditRideMutation();
  const changeMutation = useRequestRideChangeMutation();
  const claimMutation = useClaimRideDriverMutation();
  const [collisionMove, setCollisionMove] = useState<RideMove | null>(null);

  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [selectedRideId, setSelectedRideId] = useState<string | null>(null);
  const [quickRequestSlot, setQuickRequestSlot] = useState<{
    carId: string;
    day: string;
    time: string;
    showCarPicker?: boolean;
  } | null>(null);
  // Show the usual riding day first; early hours remain expandable.
  const [tableView, setTableView] = useState(false);
  const [tableZoom, setTableZoom] = useState(1);
  const [showEarlyHours, setShowEarlyHours] = useState(false);
  const boardStartMinutes = settingsQuery.data?.board_start_time
    ? parseTimeToMinutes(settingsQuery.data.board_start_time) : 6 * 60;
  const dayStartMinutes = showEarlyHours ? 0 : boardStartMinutes;
  const dayEndMinutes = 24 * 60;

  const isMyDepartment = (myDepartmentsQuery.data ?? []).some((d) => d.department_id === departmentId);
  const homeDestinationId = (departmentsQuery.data ?? []).find((d) => d.id === departmentId)?.home_destination_id ?? null;

  const rides = boardRidesQuery.data ?? [];
  const myRequestIds = new Set((myRequestsQuery.data ?? []).map((request) => request.id));
  function isMyRide(ride: BoardRide): boolean {
    return !!profileId && (ride.driver_id === profileId ||
      servedOf(ride).some((entry) => !!entry.request_id && myRequestIds.has(entry.request_id)));
  }

  const dayGroups = weekStart ? groupByDay(rides, weekStart, (r) => r.starts_at ?? "") : [];
  const today = todayInJerusalem();
  const defaultDay = dayGroups.find((g) => g.date === today)?.date ?? dayGroups[0]?.date ?? null;
  const activeDay = dayGroups.some((g) => g.date === selectedDay) ? selectedDay : defaultDay;
  const activeDayRides = dayGroups.find((g) => g.date === activeDay)?.items ?? [];

  // Quick-request-from-empty-slot (UX_FLOWS.md §18): only the live week auto-approves onto a
  // specific car (REQ §8) — an Open/Solving week has no car to target yet, the Sadran solves
  // later, so a click there just prefills the normal form's day/time instead (below).
  const isLiveWeek = resolvedWeek?.phase === "live";
  const activeDayPublished = !!activeDay && (resolvedWeek?.published_days?.includes(activeDay) ?? true);
  const isLiveDay = isLiveWeek && activeDayPublished;
  const canEditWeek = isMyDepartment && activeDayPublished && (isLiveWeek || resolvedWeek?.phase === "published");
  const now = new Date();
  const dayFreeWindows = useDayFreeWindows(departmentId, isLiveDay ? weekStart : undefined, isLiveDay ? (activeDay ?? undefined) : undefined, now);
  const defaultRideTypeId = rideTypesQuery.data?.find((rt) => rt.code === "other")?.id ?? rideTypesQuery.data?.[0]?.id ?? "";

  function handleSlotClick(carId: string, minutes: number) {
    if (!weekStart || !activeDay) return;
    const time = formatMinutes(minutes);
    if (isLiveDay) {
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
  const freeGapRows = isLiveDay
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
  const ownsSelectedRide = !!selectedRide && isMyRide(selectedRide);
  const canEditPublicNotes = !!selectedRide && selectedRide.status !== "cancelled" &&
    !!selectedRide.ends_at && Date.parse(selectedRide.ends_at) > now.getTime() &&
    (resolvedWeek?.phase !== "archived") &&
    (isSadran || (canEditWeek && ownsSelectedRide) || !!profileQuery.data?.is_admin);
  const pendingChanges = changesQuery.data ?? [];
  const shadowedRideIds = new Set(pendingChanges.flatMap((c) => [c.ride_id, ...c.parties.map((p) => p.ride_id)]));
  const tightRideIds = tightScheduleRideIds(boardRidesQuery.data ?? [], settingsQuery.data?.turnaround_minutes ?? 30);

  function ownsEditableRide(rideId: string) {
    const ride = boardRidesQuery.data?.find((r) => r.id === rideId);
    if (!ride) return false;
    if (servedOf(ride).some((entry) => entry.role !== "driver" || entry.car_mode !== "keep")) return false;
    return !!(canEditWeek && ride.driver_id === profileId && ride.starts_at && Date.parse(ride.starts_at) > now.getTime()
      && !pendingChanges.some((c) => c.ride_id === rideId));
  }

  async function saveMove(move: RideMove) {
    const ride = boardRidesQuery.data?.find((r) => r.id === move.rideId);
    if (!ride || !ownsEditableRide(move.rideId) || !departmentId || !weekStart || !ride.origin_id || !ride.destination_id) return;
    if (conflictingRides(move, boardRidesQuery.data ?? [], settingsQuery.data?.turnaround_minutes ?? 30).length) {
      setCollisionMove(move);
      return;
    }
    try {
      await editMutation.mutateAsync({
        input: { id: move.rideId, department_id: departmentId, week_start: weekStart, car_id: move.carId,
          starts_at: move.startsAt, ends_at: move.endsAt, origin_id: ride.origin_id, destination_id: ride.destination_id,
          driver_id: ride.driver_id },
        expectedVersion: move.expectedVersion, departmentId, weekStart,
      });
      await queryClient.invalidateQueries({ queryKey: ["siddur"] });
      setSelectedRideId(null);
      toast.success(he.rideEditing.saved);
    } catch { /* Mutation displays the database validation error. */ }
  }

  function moveRide(rideId: string, carId: string, startMinutes: number, endMinutes?: number) {
    const ride = boardRidesQuery.data?.find((r) => r.id === rideId);
    if (!ride?.starts_at || !ride.ends_at || !ownsEditableRide(rideId)) return;
    const duration = (Date.parse(ride.ends_at) - Date.parse(ride.starts_at)) / 60_000;
    const move = moveOnRideDay(ride, carId, startMinutes, endMinutes ?? startMinutes + duration);
    if (move) void saveMove(move);
  }

  function validMemberTarget(rideId: string, carId: string, startMinutes: number, endMinutes: number) {
    const ride = boardRidesQuery.data?.find((r) => r.id === rideId);
    const car = carsQuery.data?.find((c) => c.id === carId);
    if (!ride || !car || car.status !== "active" || (car.type === "temporary" && car.owner_id !== profileId)) return false;
    const move = moveOnRideDay(ride, carId, startMinutes, endMinutes);
    if (!move || Date.parse(move.startsAt) <= now.getTime()) return false;
    const buffer = settingsQuery.data?.turnaround_minutes ?? 30;
    if (conflictingRides(move, boardRidesQuery.data ?? [], buffer).length) return false;
    if ((maintenanceQuery.data ?? []).some((block) => block.car_id === carId && Date.parse(move.startsAt) < Date.parse(block.ends_at)
      && Date.parse(move.endsAt) + buffer * 60_000 > Date.parse(block.starts_at))) return false;
    const served = servedOf(ride);
    const need = served.reduce((sum, entry) => ({ adults: sum.adults + entry.adults, child: sum.child + entry.child_seats, boosters: sum.boosters + entry.boosters }), { adults: served.length && !served.some((entry) => entry.role === "driver") ? 1 : 0, child: 0, boosters: 0 });
    return (seatsQuery.data ?? []).some((config) => config.car_id === carId && config.adults >= Math.max(1, need.adults) && config.child_seats >= need.child && config.boosters >= need.boosters);
  }
  const selectedCar = selectedRide ? (carsQuery.data ?? []).find((c) => c.id === selectedRide.car_id) ?? null : null;
  const selectedLocation = selectedRide
    ? carLocationsQuery.data?.find((l) => l.car_id === selectedRide.car_id)?.location_name ?? null
    : null;

  const weekGridCars: WeekGridCar[] = useMemo(
    () =>
      (carsQuery.data ?? []).map((c) => ({
        id: c.id,
        name: siddurCarName(c),
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
      endMinutes: minutesSinceMidnight(r.starts_at as string) + (Date.parse(r.ends_at as string) - Date.parse(r.starts_at as string)) / 60_000,
      label:
        (!servedOf(r).length && r.notes) || (homeDestinationId && r.origin_id && r.destination_id
          ? rideBlockLabel({
              originId: r.origin_id,
              destinationId: r.destination_id,
              originName: r.origin_name ?? "",
              destinationName: r.destination_name ?? "",
              homeDestinationId,
              served: servedOf(r),
              driverName: r.driver_name,
              isChauffeur: !!r.is_chauffeur,
              needsDriver: !!r.needs_driver,
            })
          : (r.destination_name ?? "")),
      rideTypeCode: representativeRideTypeCode(servedOf(r)),
      description: [servedOf(r).length ? r.notes : null, ridePublicDetails(servedOf(r), { includeCompanions: !isSadran })].filter(Boolean).join("\n"),
      passengerSummary: isSadran ? ridePassengerSummary(servedOf(r), r.needs_driver ? null : r.driver_name) : undefined,
      coordinatorNotes: rideCoordinatorNotes(servedOf(r), coordinatorRequests),
      shadowed: shadowedRideIds.has(r.id as string),
      needsDriver: !!r.needs_driver,
      isMine: isMyRide(r),
      tightSchedule: tightRideIds.has(r.id as string),
    }));
  for (const change of pendingChanges) {
    if (formatInTimeZone(change.starts_at, TZ, "yyyy-MM-dd") !== activeDay) continue;
    const original = weekGridRides.find((r) => r.id === change.ride_id);
    weekGridRides.push({ id: `change:${change.id}`, carId: change.car_id,
      startMinutes: minutesSinceMidnight(change.starts_at),
      endMinutes: minutesSinceMidnight(change.starts_at) + (Date.parse(change.ends_at) - Date.parse(change.starts_at)) / 60_000,
      label: `${original?.label ?? change.requester?.full_name ?? ""} · ${he.rideEditing.pending}`,
      pendingConsent: true, rideTypeCode: original?.rideTypeCode,
      isMine: original?.isMine, needsDriver: original?.needsDriver });
  }

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
          (myDepartmentsQuery.data?.length ?? 0) > 1 ? (
            <Select
              value={departmentId}
              onValueChange={(next) => { active.setDepartmentId(next); goTo(next, undefined); }}
            >
              <SelectTrigger className="w-40">
                <SelectValue placeholder={he.siddur.departmentSwitcher} />
              </SelectTrigger>
              <SelectContent>
                {(myDepartmentsQuery.data ?? []).map((membership) => (
                  <SelectItem key={membership.department_id} value={membership.department_id}>
                    {membership.department.name}
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
          {!activeDayPublished ? <p className="rounded-md border bg-muted/40 p-3 text-sm">{he.publicationFlow.dayUnpublished}</p> : null}
          <TableViewControls table={tableView} onTableChange={setTableView} zoom={tableZoom} onZoomChange={setTableZoom} />
          <div className={tableView ? "hidden" : "lg:hidden"}>
            <WeekStrip weekStart={weekStart as string} counts={dayCounts} selected={activeDay ?? ""} onSelect={setSelectedDay} />
            <div className="mt-3 space-y-2">
              {isMyDepartment && isLiveDay ? (
                <Button type="button" variant="outline" className="w-full" onClick={handleTakeCarNow}>
                  {t("quickRequest.takeCarNow")}
                </Button>
              ) : null}
              {boardRidesQuery.isLoading ? (
                <CardListSkeleton />
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
                    label: weekGridRides.find((item) => item.id === r.id)?.label,
                    description: [servedOf(r).length ? r.notes : null, ridePublicDetails(servedOf(r), { includeCompanions: !isSadran })].filter(Boolean).join("\n"),
                    passengerSummary: isSadran ? ridePassengerSummary(servedOf(r), r.needs_driver ? null : r.driver_name) : undefined,
                    coordinatorNotes: rideCoordinatorNotes(servedOf(r), coordinatorRequests),
                    driverName: r.driver_name,
                    isChauffeur: !!r.is_chauffeur,
                    needsDriver: !!r.needs_driver,
                    isMine: isMyRide(r),
                    tightSchedule: tightRideIds.has(r.id as string),
                    carName: siddurCarName(carsQuery.data?.find((c) => c.id === r.car_id)) || null,
                    carType: (carsQuery.data ?? []).find((c) => c.id === r.car_id)?.type,
                    rideTypeCode: representativeRideTypeCode(servedOf(r)),
                  };
                  return <div key={r.id} className={shadowedRideIds.has(r.id as string) ? "opacity-50" : undefined}><RideCard ride={data} onClick={() => setSelectedRideId(r.id as string)} /></div>;
                })
              )}
              {pendingChanges.filter((c) => formatInTimeZone(c.starts_at, TZ, "yyyy-MM-dd") === activeDay).map((c) => (
                <div key={c.id} className="rounded-md border border-dashed border-primary p-3 text-sm">
                  <p className="font-medium">{c.requester?.full_name} · {he.rideEditing.pending}</p>
                  <p>{siddurCarName(carsQuery.data?.find((car) => car.id === c.car_id))} · <span dir="ltr">{formatInTimeZone(c.starts_at, TZ, "HH:mm")}–{formatInTimeZone(c.ends_at, TZ, "HH:mm")}</span></p>
                </div>
              ))}
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

          <div className={tableView ? "min-w-0" : "hidden lg:block"}>
            <div className="flex items-center justify-between gap-2">
              <WeekStrip weekStart={weekStart as string} counts={dayCounts} selected={activeDay ?? ""} onSelect={setSelectedDay} />
              <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setShowEarlyHours((v) => !v)}>
                {showEarlyHours ? he.board.hideEarlyHours : he.board.showEarlyHours}
              </Button>
            </div>
            <RideTypeLegend
              types={(rideTypesQuery.data ?? []).map((rt) => ({ code: rt.code, nameHe: rt.name_he }))}
            />
            <div className="mt-3">
              <WeekGrid
                zoom={tableZoom}
                cars={weekGridCars}
                rides={weekGridRides}
                dayStartMinutes={dayStartMinutes}
                dayEndMinutes={dayEndMinutes}
                readOnly={!canEditWeek}
                draggable={canEditWeek && !editMutation.isPending && !changeMutation.isPending}
                canDragRide={(ride) => ownsEditableRide(ride.id)}
                isDropTargetValid={validMemberTarget}
                onRideDrop={(rideId, carId, startMinutes) => moveRide(rideId, carId, startMinutes)}
                onRideResize={(rideId, edge, minutes) => {
                  const ride = weekGridRides.find((r) => r.id === rideId);
                  if (ride) moveRide(rideId, ride.carId, edge === "start" ? minutes : ride.startMinutes, edge === "end" ? minutes : ride.endMinutes);
                }}
                onRideClick={setSelectedRideId}
                onSlotClick={isMyDepartment ? handleSlotClick : undefined}
              />
            </div>
          </div>
        </>
      )}

      <RideDetailSheet
        ride={selectedRide}
        coordinatorNotes={selectedRide ? rideCoordinatorNotes(servedOf(selectedRide), coordinatorRequests) : undefined}
        canEditPublicNotes={canEditPublicNotes}
        passengerSummary={isSadran && selectedRide ? ridePassengerSummary(servedOf(selectedRide), selectedRide.needs_driver ? null : selectedRide.driver_name) : undefined}
        car={selectedCar}
        locationBadge={selectedLocation}
        homeDestinationId={homeDestinationId}
        onOpenChange={(open) => !open && setSelectedRideId(null)}
        onAskToJoin={() => selectedRide && navigate(`/requests/new?ride=${selectedRide.id}`)}
        showAskToJoin={!!selectedRide && activeDayPublished && !selectedRide.needs_driver && isMyDepartment && selectedRide.driver_id !== profileId}
        editor={selectedRide?.needs_driver && canEditWeek && selectedRide.ends_at && Date.parse(selectedRide.ends_at) > now.getTime() ? (
          <div className="space-y-2 rounded-md border border-destructive/50 p-3">
            <p className="font-semibold text-destructive">{he.rideCoordination.missingDriver}</p>
            <p>{he.rideCoordination.volunteerHelp}</p>
            <Button className="w-full" disabled={claimMutation.isPending} onClick={() => {
              if (selectedRide.id && selectedRide.version != null) claimMutation.mutate({ rideId: selectedRide.id, expectedVersion: selectedRide.version }, {
                onSuccess: () => { setSelectedRideId(null); toast.success(he.rideCoordination.volunteered); },
              });
            }}>{he.rideCoordination.volunteer}</Button>
          </div>
        ) : selectedRide?.id && ownsEditableRide(selectedRide.id) ? <MemberRideEditor key={`${selectedRide.id}:${selectedRide.version}`} ride={selectedRide} cars={carsQuery.data ?? []} saving={editMutation.isPending || changeMutation.isPending} onSave={(move) => void saveMove(move)} /> : undefined}
      />

      <Dialog open={!!collisionMove} onOpenChange={(open) => !open && setCollisionMove(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{he.rideEditing.collisionTitle}</DialogTitle><DialogDescription>{he.rideEditing.collisionBody}</DialogDescription></DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCollisionMove(null)}>{he.common.cancel}</Button>
            <Button disabled={changeMutation.isPending} onClick={() => {
              if (!collisionMove) return;
              changeMutation.mutate(collisionMove, { onSuccess: () => {
                setCollisionMove(null); setSelectedRideId(null); toast.success(he.rideEditing.requested);
              } });
            }}>{he.rideEditing.acknowledge}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
