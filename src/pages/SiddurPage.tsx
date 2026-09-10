import { useProfile } from "@/features/auth/useProfile";
import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { parseTimeToMinutes } from "@/features/solverBridge/buildSolverInput";
import { CalendarDays, Inbox } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { formatWeekRangeLabel, todayInJerusalem } from "@/components/DateField";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { RideCard, type RideCardData } from "@/components/RideCard";
import { StatusBadge } from "@/components/StatusBadge";
import { RideTypeLegend } from "@/components/RideTypeLegend";
import { CardListSkeleton } from "@/components/skeletons/CardListSkeleton";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatMinutes } from "@/components/TimeField15";
import { WeekGrid, type WeekGridCar, type WeekGridDiscussionBlock, type WeekGridRide } from "@/components/WeekGrid";
import { WeekStrip } from "@/components/WeekStrip";
import { WaitlistGroupCard } from "@/features/waitlist/components/WaitlistGroupCard";
import { WaitlistGroupSheet } from "@/features/waitlist/components/WaitlistGroupSheet";
import { useWaitlistGroupsQuery } from "@/features/waitlist/hooks";
import { useMyDepartments } from "@/features/auth/useMyDepartments";
import { useSession } from "@/features/auth/useSession";
import { useIsSadran } from "@/features/auth/useIsSadran";
import { useMyRequests, useCancelRideMutation } from "@/features/requests/hooks";
import { CarNameWithReport } from "@/features/carCare/components/CarNameWithReport";
import { useCars, useRideTypes, useMaintenanceBlocks, useCarSeatConfigs } from "@/features/fleet/hooks";
import { AddRideFab } from "@/features/requests/components/AddRideFab";
import { CarNowButton } from "@/features/requests/components/CarNowButton";
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
import { type CarFreeWindow } from "@/features/siddur/freeWindows";
import {
  useBoardRides,
  useCarLocations,
  useDepartments,
  useWeeks,
  useRideChanges,
  useRequestRideChangeMutation,
  useClaimRideDriverMutation,
} from "@/features/siddur/hooks";
import { useDayFreeWindows, type DayFreeWindowsAway, type DayFreeWindowsCar } from "@/features/siddur/useDayFreeWindows";
import { isPastWeek } from "@/features/siddur/pastWeeks";
import { useSiddurDisplayPrefs } from "@/features/siddur/useSiddurDisplayPrefs";
import { resolveThisNextWeek } from "@/features/siddur/thisNextWeek";
import { WeekSwitcherTitle } from "@/features/siddur/components/WeekSwitcherTitle";
import { SiddurDisplayMenu } from "@/features/siddur/components/SiddurDisplayMenu";
import { siddurKeys } from "@/features/siddur/queryKeys";
import type { Week, RideMove, BoardRide } from "@/features/siddur/api";
import { representativeRideTypeCode, servedOf } from "@/features/sadran/solverRun";
import { rideBlockLabel, resolveRideRealDestination } from "@/lib/rideLabel";
import { he, t, tv } from "@/i18n/he";
import { dateKey, formatTime } from "@/lib/time";
import { weekdayLabel } from "@/lib/dayLabels";
import { cn } from "@/lib/utils";
import { paths } from "@/app/routes";

/**
 * Live > Published > soonest Open (UX_FLOWS §3.5: the siddur opens on the
 * relevant week). `archived` is deliberately excluded from the "published"
 * bucket (Archive of past siddurim, owner decision 2026-09-10): an archived
 * week is always past, and this default must never land on a past week —
 * opening one is only ever explicit, either by URL or from `/siddur/:dept/archive`.
 */
function resolveSiddurWeek(weeks: readonly Week[]): Week | null {
  const live = weeks.find((w) => w.phase === "live");
  if (live) return live;
  const published = [...weeks]
    .filter((w) => w.phase === "published")
    .sort((a, b) => (a.week_start < b.week_start ? 1 : -1))[0];
  if (published) return published;
  const open = [...weeks].filter((w) => w.phase === "open").sort((a, b) => (a.week_start < b.week_start ? -1 : 1))[0];
  return open ?? null;
}

function minutesSinceMidnight(instant: string): number {
  const [h, m] = formatTime(new Date(instant)).split(":").map(Number);
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
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { session } = useSession();
  const profileId = session?.user.id;
  const myDepartmentsQuery = useMyDepartments();
  const departmentsQuery = useDepartments();
  const active = useActiveDepartment();
  const profileQuery = useProfile();
  const cancelRideMutation = useCancelRideMutation();

  const defaultDepartmentId =
    active.departmentId;
  const departmentId = params.dept ?? defaultDepartmentId;

  const weeksQuery = useWeeks(departmentId);
  const weeks = weeksQuery.data ?? [];
  const resolvedWeek = params.week ? weeks.find((w) => w.week_start === params.week) ?? null : resolveSiddurWeek(weeks);
  const weekStart = resolvedWeek?.week_start;
  const { isSadran } = useIsSadran(departmentId, weekStart);
  const coordinatorRequestsQuery = useWeekRequestsWithNames(isSadran ? departmentId : undefined, weekStart);
  const myRequestsQuery = useMyRequests();
  const coordinatorRequests = isSadran ? coordinatorRequestsQuery.data ?? [] : [];

  const boardRidesQuery = useBoardRides(departmentId, weekStart);
  const waitlistGroupsQuery = useWaitlistGroupsQuery(departmentId, weekStart);
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
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [quickRequestSlot, setQuickRequestSlot] = useState<{
    carId: string;
    day: string;
    weekStart: string;
    time: string;
    showCarPicker?: boolean;
    cars: DayFreeWindowsCar[];
    freeWindows: CarFreeWindow[];
    awayWindows: DayFreeWindowsAway[];
  } | null>(null);
  // Per-device display preferences (cards/table, zoom, early hours) — UX_FLOWS.md member
  // siddur "display" menu, persisted in `localStorage` (`useSiddurDisplayPrefs`).
  const { tableView, setTableView, tableZoom, setTableZoom, showEarlyHours, setShowEarlyHours } = useSiddurDisplayPrefs();
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

  // `?ride=<id>` (notification deep link, `notification_default_url`'s
  // `/siddur/<dept>/<week>?ride=<id>` case): open the ride detail sheet for it once, on the
  // ride's own day, and ring-highlight its day-list card (mirrors `?focus=` on `/requests`
  // and `?proposal=` on `ProposalsListScreen`). Handled synchronously during render with a
  // "already handled" state flag — the same "adjust state for freshly-arrived data" idiom
  // `RequestForm`'s edit-mode reset uses — rather than a `useEffect` (closing the sheet clears
  // `selectedRideId` while this param stays in the URL, and both `setState` and ref access from
  // inside an effect *or* render body are separately restricted by this codebase's
  // `react-hooks/set-state-in-effect` and `react-hooks/refs` lint rules; plain `useState` for
  // the guard avoids both).
  const focusRideId = searchParams.get("ride");
  const [handledRideFocus, setHandledRideFocus] = useState<string | null>(null);
  if (focusRideId && handledRideFocus !== focusRideId) {
    const focusedRide = rides.find((r) => r.id === focusRideId);
    if (focusedRide?.starts_at) {
      setHandledRideFocus(focusRideId);
      setSelectedDay(dateKey(new Date(focusedRide.starts_at)));
      setSelectedRideId(focusRideId);
    }
  }
  const highlightedRideRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focusRideId) highlightedRideRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusRideId]);

  // `?group=<id>` (notification deep link, `notification_default_url`'s
  // `/siddur/<dept>/<week>?day=<day>&group=<id>` case, REQ §13.75): open that
  // day and the resolution sheet for the group once, the same "adjust state
  // for freshly-arrived data" idiom `focusRideId` above uses.
  const focusGroupId = searchParams.get("group");
  const [handledGroupFocus, setHandledGroupFocus] = useState<string | null>(null);
  if (focusGroupId && handledGroupFocus !== focusGroupId) {
    const focusedGroup = (waitlistGroupsQuery.data ?? []).find((g) => g.id === focusGroupId);
    if (focusedGroup) {
      setHandledGroupFocus(focusGroupId);
      setSelectedDay(focusedGroup.day);
      setSelectedGroupId(focusGroupId);
    }
  }

  const dayGroups = weekStart ? groupByDay(rides, weekStart, (r) => r.starts_at ?? "") : [];
  const today = todayInJerusalem();
  const defaultDay = dayGroups.find((g) => g.date === today)?.date ?? dayGroups[0]?.date ?? null;
  const activeDay = dayGroups.some((g) => g.date === selectedDay) ? selectedDay : defaultDay;
  const activeDayRides = dayGroups.find((g) => g.date === activeDay)?.items ?? [];
  // Contested waiting-list groups (REQ §13.75, UX_FLOWS.md §3.5): one "בדיון" block/card per
  // still-open group on the displayed day, alongside the day's rides.
  const activeDayWaitlistGroups = (waitlistGroupsQuery.data ?? []).filter((group) => group.day === activeDay);
  const selectedWaitlistGroup = (waitlistGroupsQuery.data ?? []).find((group) => group.id === selectedGroupId) ?? null;
  // On the current day, open the calendar at the full hour before now. This
  // leaves enough recent context to see a ride that has just begun.
  const initialGridScrollMinutes = !tableView && activeDay === today
    ? Math.floor(minutesSinceMidnight(new Date().toISOString()) / 60) * 60 - 60
    : null;

  // Quick-request-from-empty-slot (UX_FLOWS.md §18): only the live week auto-approves onto a
  // specific car (REQ §8) — an Open/Solving week has no car to target yet, the Sadran solves
  // later, so a click there just prefills the normal form's day/time instead (below).
  const isLiveWeek = resolvedWeek?.phase === "live";
  const activeDayPublished = !!activeDay && (resolvedWeek?.published_days?.includes(activeDay) ?? true);
  const isLiveDay = isLiveWeek && activeDayPublished;
  const canEditWeek = isMyDepartment && activeDayPublished && (isLiveWeek || resolvedWeek?.phase === "published");
  const now = new Date();
  const dayFreeWindows = useDayFreeWindows(departmentId, isLiveDay ? weekStart : undefined, isLiveDay ? (activeDay ?? undefined) : undefined, now);

  function handleSlotClick(carId: string, minutes: number) {
    if (!weekStart || !activeDay) return;
    const time = formatMinutes(minutes);
    if (isLiveDay) {
      setQuickRequestSlot({
        carId, day: activeDay, weekStart, time,
        cars: dayFreeWindows.cars, freeWindows: dayFreeWindows.freeWindows, awayWindows: dayFreeWindows.awayWindows,
      });
    } else {
      navigate(paths.requests.new({ week: weekStart, day: activeDay, time }));
    }
  }

  /** Free gaps ≥ 1h per car, tappable rows in the phone day list (UX_FLOWS.md §18). */
  const freeGapRows = isLiveDay
    ? dayFreeWindows.freeWindows
        .filter((w) => w.end - w.start >= 60 * 60_000)
        .map((w) => ({
          ...w,
          carName: dayFreeWindows.cars.find((c) => c.id === w.carId)?.name ?? "",
          startTime: formatTime(new Date(w.start)),
          endTime: formatTime(new Date(w.end)),
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
      await queryClient.invalidateQueries({ queryKey: siddurKeys.all });
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
      seriesIndex: r.series_index,
      seriesCount: r.series_count,
    }));
  for (const change of pendingChanges) {
    if (dateKey(change.starts_at) !== activeDay) continue;
    const original = weekGridRides.find((r) => r.id === change.ride_id);
    weekGridRides.push({ id: `change:${change.id}`, carId: change.car_id,
      startMinutes: minutesSinceMidnight(change.starts_at),
      endMinutes: minutesSinceMidnight(change.starts_at) + (Date.parse(change.ends_at) - Date.parse(change.starts_at)) / 60_000,
      label: `${original?.label ?? change.requester?.full_name ?? ""} · ${he.rideEditing.pending}`,
      pendingConsent: true, rideTypeCode: original?.rideTypeCode,
      isMine: original?.isMine, needsDriver: original?.needsDriver });
  }

  const weekGridDiscussionBlocks: WeekGridDiscussionBlock[] = activeDayWaitlistGroups.map((group) => ({
    id: group.id,
    startMinutes: minutesSinceMidnight(group.starts_at),
    endMinutes: minutesSinceMidnight(group.starts_at) + (Date.parse(group.ends_at) - Date.parse(group.starts_at)) / 60_000,
    label: tv("waitlist.blockLabel", { names: group.members.map((member) => member.name).join(", ") }),
  }));

  function goTo(nextDept: string, nextWeek: string | undefined) {
    navigate(paths.siddur({ dept: nextDept, week: nextWeek }));
  }

  const dayCounts = dayGroups.map((g) => ({ rides: g.items.length, unmet: 0 }));
  const thisNextWeek = resolveThisNextWeek(weeks, today);
  // Archive of past siddurim (owner decision, 2026-09-10): the regular week
  // switcher/strip only ever offers this week onward; a past week is only
  // reachable explicitly (by URL, or from `/siddur/:dept/archive`), and when
  // it is opened this way the page says so next to the title. An `upcoming`
  // week (materialized early for a multi-day series leg, REQ §13.79) is not
  // past, but it is not open for anything either — members never see it here.
  const currentWeeks = weeks.filter((w) => !isPastWeek(w, today) && w.phase !== "upcoming");
  const viewingArchivedWeek = !!resolvedWeek && isPastWeek(resolvedWeek, today);
  function goToArchive() {
    if (departmentId) navigate(paths.siddurArchive(departmentId));
  }
  const departmentSwitcher = (myDepartmentsQuery.data?.length ?? 0) > 1 ? (
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
  ) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 pb-24">
      {/* Mobile header (below `md`): the title is itself the this-week/next-week switcher; the
          eye icon collapses every `TableViewControls` option plus "show early hours" into one
          menu (UX_FLOWS.md member siddur "mobile header"). */}
      <div className="flex items-center justify-between gap-2 py-2 md:hidden">
        {/* Keeps a stable, discoverable page heading for assistive tech (and existing
            navigation-by-heading checks) even though the visible title text now switches
            between "השבוע"/"שבוע הבא" as the week switcher itself. */}
        <h1 className="sr-only">{t("screen.siddur.title")}</h1>
        <WeekSwitcherTitle resolution={thisNextWeek} activeWeekStart={weekStart} onSelect={(next) => goTo(departmentId as string, next)} onArchive={goToArchive} />
        <SiddurDisplayMenu
          table={tableView}
          onTableChange={setTableView}
          zoom={tableZoom}
          onZoomChange={setTableZoom}
          showEarlyHours={showEarlyHours}
          onShowEarlyHoursChange={setShowEarlyHours}
        />
      </div>
      {departmentSwitcher ? <div className="md:hidden">{departmentSwitcher}</div> : null}

      <div className="hidden md:block">
        <PageHeader
          title={t("screen.siddur.title")}
          subtitle={weekStart ? formatWeekRangeLabel(weekStart) : undefined}
          actions={departmentSwitcher ?? undefined}
        />
      </div>

      {!isMyDepartment ? <p className="text-xs text-muted-foreground">{he.siddur.otherDeptNote}</p> : null}
      {viewingArchivedWeek ? <p className="text-xs text-muted-foreground">{he.siddur.archivedWeekHint}</p> : null}

      {departmentId ? (
        <div className="hidden items-center gap-2 overflow-x-auto md:flex">
          {currentWeeks.map((w) => (
            <button
              key={w.week_start}
              type="button"
              onClick={() => goTo(departmentId as string, w.week_start)}
              className={
                "flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs " +
                (w.week_start === weekStart ? "border-primary bg-primary/10" : "border-input")
              }
            >
              <span dir="ltr">{formatWeekRangeLabel(w.week_start)}</span>
              <StatusBadge kind="week" status={w.phase} className="h-5 px-1.5 py-0 text-[10px]" />
            </button>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ms-auto shrink-0"
            onClick={goToArchive}
            data-testid="siddur-archive-link"
          >
            {he.siddur.archive}
          </Button>
        </div>
      ) : null}

      {!resolvedWeek ? (
        <EmptyState icon={CalendarDays} message={he.requestsList.empty} />
      ) : resolvedWeek.phase === "open" || resolvedWeek.phase === "solving" || resolvedWeek.phase === "upcoming" ? (
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
          {/* Desktop: the same display menu as mobile; "show early hours" lives only here. */}
          <div className="hidden md:flex md:justify-end">
            <SiddurDisplayMenu
              table={tableView}
              onTableChange={setTableView}
              zoom={tableZoom}
              onZoomChange={setTableZoom}
              showEarlyHours={showEarlyHours}
              onShowEarlyHoursChange={setShowEarlyHours}
            />
          </div>
          <div className={tableView ? "hidden" : "lg:hidden"}>
            <WeekStrip weekStart={weekStart as string} counts={dayCounts} selected={activeDay ?? ""} onSelect={setSelectedDay} />
            <div className="mt-3 space-y-2">
              {isMyDepartment ? (
                <div className="grid grid-cols-2 gap-2">
                  {departmentId ? <CarNowButton departmentId={departmentId} className="w-full" /> : null}
                  {activeDayPublished && (resolvedWeek?.phase === "published" || isLiveWeek) && weekStart && activeDay ? (
                    <Button type="button" variant="outline" className="w-full" onClick={() => navigate(paths.requests.new({ week: weekStart, day: activeDay, waitlist: true }))}>
                      {tv("siddur.waitlistForDay", { day: weekdayLabel(`${activeDay}T12:00:00Z`, "short") })}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {boardRidesQuery.isLoading ? (
                <CardListSkeleton />
              ) : activeDayRides.length === 0 && freeGapRows.length === 0 && activeDayWaitlistGroups.length === 0 ? (
                <EmptyState icon={CalendarDays} message={he.siddur.noRides} />
              ) : (
                <>
                  {activeDayWaitlistGroups.map((group) => (
                    <WaitlistGroupCard key={group.id} group={group} onClick={() => setSelectedGroupId(group.id)} />
                  ))}
                  {activeDayRides.map((r) => {
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
                    carId: r.car_id,
                    carType: (carsQuery.data ?? []).find((c) => c.id === r.car_id)?.type,
                    rideTypeCode: representativeRideTypeCode(servedOf(r)),
                    seriesIndex: r.series_index,
                    seriesCount: r.series_count,
                  };
                  return (
                    <div
                      key={r.id}
                      ref={r.id === focusRideId ? highlightedRideRef : undefined}
                      className={cn(
                        shadowedRideIds.has(r.id as string) && "opacity-50",
                        r.id === focusRideId && "ring-2 ring-primary rounded-md",
                      )}
                    >
                      <RideCard ride={data} onClick={() => setSelectedRideId(r.id as string)} />
                    </div>
                  );
                  })}
                </>
              )}
              {pendingChanges.filter((c) => dateKey(c.starts_at) === activeDay).map((c) => (
                <div key={c.id} className="rounded-md border border-dashed border-primary p-3 text-sm">
                  <p className="font-medium">{c.requester?.full_name} · {he.rideEditing.pending}</p>
                  <p>{siddurCarName(carsQuery.data?.find((car) => car.id === c.car_id))} · <span dir="ltr">{formatTime(new Date(c.starts_at))}–{formatTime(new Date(c.ends_at))}</span></p>
                </div>
              ))}
              {isMyDepartment
                ? freeGapRows.map((gap) => (
                    <button
                      key={`${gap.carId}-${gap.start}`}
                      type="button"
                      className="w-full rounded-md border border-dashed p-3 text-start text-sm text-muted-foreground hover:bg-accent/40"
                      onClick={() => setQuickRequestSlot({
                        carId: gap.carId, day: activeDay as string, weekStart: weekStart as string, time: gap.startTime,
                        cars: dayFreeWindows.cars, freeWindows: dayFreeWindows.freeWindows, awayWindows: dayFreeWindows.awayWindows,
                      })}
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
            <WeekStrip weekStart={weekStart as string} counts={dayCounts} selected={activeDay ?? ""} onSelect={setSelectedDay} />
            <RideTypeLegend
              types={(rideTypesQuery.data ?? []).map((rt) => ({ code: rt.code, nameHe: rt.name_he }))}
            />
            <div className="mt-3">
              <WeekGrid
                zoom={tableZoom}
                onZoomChange={setTableZoom}
                cars={weekGridCars}
                rides={weekGridRides}
                dayStartMinutes={dayStartMinutes}
                dayEndMinutes={dayEndMinutes}
                initialScrollMinutes={initialGridScrollMinutes}
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
                renderCarName={(car) => <CarNameWithReport carId={car.id} carName={car.name} className="min-w-0" />}
                discussionBlocks={weekGridDiscussionBlocks}
                onDiscussionClick={setSelectedGroupId}
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
        onAskToJoin={() => selectedRide?.id && navigate(paths.requests.new({ ride: selectedRide.id }))}
        showAskToJoin={!!selectedRide && activeDayPublished && !selectedRide.needs_driver && isMyDepartment && selectedRide.driver_id !== profileId}
        onRemoveOwnRide={selectedRide?.id && ownsSelectedRide && selectedRide.version != null ? () => cancelRideMutation.mutate({ rideId: selectedRide.id!, expectedVersion: selectedRide.version!, reason: "CANCELLED_BY_MEMBER" }, { onSuccess: () => setSelectedRideId(null) }) : undefined}
        removingOwnRide={cancelRideMutation.isPending}
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

      <WaitlistGroupSheet
        group={selectedWaitlistGroup}
        departmentId={departmentId as string}
        weekStart={weekStart as string}
        profileId={profileId}
        canManageWeek={isSadran}
        onOpenChange={(open) => !open && setSelectedGroupId(null)}
      />

      <ConfirmDialog
        open={!!collisionMove}
        onOpenChange={(open) => !open && setCollisionMove(null)}
        title={he.rideEditing.collisionTitle}
        description={he.rideEditing.collisionBody}
        confirmLabel={he.rideEditing.acknowledge}
        loading={changeMutation.isPending}
        onConfirm={() => {
          if (!collisionMove) return;
          changeMutation.mutate(collisionMove, { onSuccess: () => {
            setCollisionMove(null); setSelectedRideId(null); toast.success(he.rideEditing.requested);
          } });
        }}
      />

      {isMyDepartment ? (
        <AddRideFab />
      ) : null}

      {quickRequestSlot ? (
        <QuickRequestSheet
          open={!!quickRequestSlot}
          onOpenChange={(open) => !open && setQuickRequestSlot(null)}
          departmentId={departmentId as string}
          weekStart={quickRequestSlot.weekStart}
          day={quickRequestSlot.day}
          initialStartTime={quickRequestSlot.time}
          initialCarId={quickRequestSlot.carId}
          showCarPicker={quickRequestSlot.showCarPicker}
          cars={quickRequestSlot.cars}
          freeWindows={quickRequestSlot.freeWindows}
          awayWindows={quickRequestSlot.awayWindows}
          now={now}
        />
      ) : null}
    </div>
  );
}
