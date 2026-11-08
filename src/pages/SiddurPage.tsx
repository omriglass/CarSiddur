import { useMaintenanceGridEditing } from "@/features/fleet/useMaintenanceGridEditing";
import { useWeekChangeWatch } from "@/features/liveSync/useWeekChangeWatch";
import { useProfile } from "@/features/auth/useProfile";
import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { parseTimeToMinutes } from "@/features/solverBridge/buildSolverInput";
import { CalendarDays, Inbox } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { formatWeekRangeLabel, todayInJerusalem } from "@/components/dateFieldDates";
import { CarSwapDialog } from "@/components/CarSwapDialog";
import { DraftWatermark } from "@/components/DraftWatermark";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { RideCard, type RideCardData } from "@/components/RideCard";
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
import { formatMinutes } from "@/components/timeField15Format";
import { WeekGrid, type WeekGridCar, type WeekGridDiscussionBlock, type WeekGridRide } from "@/components/WeekGrid";
import { WeekStrip } from "@/components/WeekStrip";
import { WaitlistGroupCard } from "@/features/waitlist/components/WaitlistGroupCard";
import { WaitlistGroupSheet } from "@/features/waitlist/components/WaitlistGroupSheet";
import { useSiddurWaitlistQuery, useWaitlistGroupsQuery } from "@/features/waitlist/hooks";
import { WaitingRequestCard } from "@/features/waitlist/components/WaitingRequestCard";
import { scrollToWaitlist } from "@/features/waitlist/scrollToWaitlist";
import { useWaitingDrop, waitingDropWarningText } from "@/features/waitlist/useWaitingDrop";
import { WaitingRequestSheet } from "@/features/waitlist/components/WaitingRequestSheet";
import { WaitlistScrollButton } from "@/features/waitlist/components/WaitlistScrollButton";
import { WAITING_LANE_PREFIX, waitingLanes, waitingRequestIdOf } from "@/features/waitlist/siddurLanes";
import { waitingLabel } from "@/features/waitlist/waitingLabels";
import { useMyDepartments } from "@/features/auth/useMyDepartments";
import { useSession } from "@/features/auth/useSession";
import { useIsSadran } from "@/features/auth/useIsSadran";
import { ownRequestIds } from "@/features/requests/filedForOther";
import { useRideEditorsQuery } from "@/features/member/hooks";
import { useMyRequests, useCancelRideMutation } from "@/features/requests/hooks";
import { canEditRequest } from "@/features/requests/window";
import { useCars, useDestinations, useRideTypes, useMaintenanceBlocks } from "@/features/fleet/hooks";
import { AddRideFab } from "@/features/requests/components/AddRideFab";
import { RequestDeadlineNote } from "@/features/requests/components/RequestDeadlineNote";
import { CarNowButton } from "@/features/requests/components/CarNowButton";
import { QuickRequestSheet } from "@/features/requests/components/QuickRequestSheet";
import { ridePublicDetails } from "@/lib/ridePublicDetails";
import { ridePassengerSummary } from "@/lib/ridePassengerSummary";
import { rideCoordinatorNotes } from "@/lib/rideCoordinatorNotes";
import { siddurCarName } from "@/lib/siddurCarName";
import { VolunteerDriverChange } from "@/features/rides/components/VolunteerDriverChange";
import { VolunteerDriverPanel } from "@/features/rides/components/VolunteerDriverPanel";
import { isDrivenOnRide, volunteerDriverOf } from "@/features/rides/driverWanted";
import { RideDetailSheet } from "@/features/siddur/components/RideDetailSheet";
import { MemberRideEditor } from "@/features/siddur/components/MemberRideEditor";
import { isMergedRide, isRideRelated, relatedRequestIdToEdit, rideEditTargets } from "@/features/rides/relatedRide";
import { useMemberRideMoves } from "@/features/rides/useMemberRideMoves";
import { useRideSheetCarActions } from "@/features/rides/useRideSheetCarActions";
import { awayBandBlocks } from "@/features/siddur/awayBands";
import { tightRideIdsOf } from "@/features/rides/tightSchedule";
import { useRecentlyWashedCarIds } from "@/features/carCare/hooks";
import { useDepartmentSettings, useWeekRequestsWithNames } from "@/features/sadran/hooks";
import { groupByDay } from "@/features/siddur/dayGrouping";
import { carAwayPlaceAtDayStart, hideIdleTemporaryCars } from "@/components/weekGridCars";
import { type CarFreeWindow } from "@/features/siddur/freeWindows";
import {
  useBoardRides,
  useCarLocations,
  useCarStartLocations,
  useDepartments,
  useWeeks,
} from "@/features/siddur/hooks";
import {
  useRideChanges,
  useRemoveRidePassengerMutation,
} from "@/features/rides/hooks";
import { useDayFreeWindows, type DayFreeWindowsAway, type DayFreeWindowsCar } from "@/features/siddur/useDayFreeWindows";
import { isPastWeek } from "@/features/siddur/pastWeeks";
import { useSiddurDisplayPrefs } from "@/features/siddur/useSiddurDisplayPrefs";
import { resolveThisNextWeek } from "@/features/siddur/thisNextWeek";
import { WeekSwitcherTitle } from "@/features/siddur/components/WeekSwitcherTitle";
import { LongRangeMenu } from "@/features/planning/components/LongRangeMenu";
import { SiddurDisplayMenu } from "@/features/siddur/components/SiddurDisplayMenu";
import { EditModeButton } from "@/features/rides/components/EditModeButton";
import { useDragHint, useEditMode } from "@/features/rides/editMode";
import type { Week, BoardRide } from "@/features/siddur/api";
import { representativeRideTypeCode, rideViaNames, servedOf } from "@/features/rides/servedOf";
import { viaLabel } from "@/lib/routeLabel";
import { isRideDayEditable } from "@/features/rides/rideDayEditable";
import { addedPeopleNames, myRidePersonKey } from "@/features/rides/ridePeople";
import { rideBlockLabel, resolveRideRealDestination } from "@/lib/rideLabel";
import { he, t, tv } from "@/i18n/he";
import { fromZonedTime } from "date-fns-tz";

import { TZ, dateKey, formatTime } from "@/lib/time";
import { weekdayLabel } from "@/lib/dayLabels";
import { cn } from "@/lib/utils";
import { effectiveWeekSettings } from "@/lib/weekSettings";
import { useRequestLinkProps } from "@/app/overlayState";
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

/** Directly `add_ride_passengers()`-added names (`people`, `source: 'added'`) — not tied to
 * any one served request, so `ridePassengerSummary`/`ridePublicDetails` take them as a
 * separate list rather than folding them into a particular requester's companions. */
function addedNamesOf(ride: BoardRide): string[] {
  return addedPeopleNames(ride, servedOf(ride));
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
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const requestLinkProps = useRequestLinkProps();

  const { session } = useSession();
  const profileId = session?.user.id;
  const myDepartmentsQuery = useMyDepartments();
  const departmentsQuery = useDepartments();
  const active = useActiveDepartment();
  const profileQuery = useProfile();
  const cancelRideMutation = useCancelRideMutation();
  const removeMeMutation = useRemoveRidePassengerMutation();

  const defaultDepartmentId =
    active.departmentId;
  const departmentId = params.dept ?? defaultDepartmentId;

  const weeksQuery = useWeeks(departmentId);
  const weeks = weeksQuery.data ?? [];
  const resolvedWeek = params.week ? weeks.find((w) => w.week_start === params.week) ?? null : resolveSiddurWeek(weeks);
  const weekStart = resolvedWeek?.week_start;
  const { isSadran, isLoading: isSadranLoading } = useIsSadran(departmentId, weekStart);
  const coordinatorRequestsQuery = useWeekRequestsWithNames(isSadran ? departmentId : undefined, weekStart);
  const myRequestsQuery = useMyRequests();
  const coordinatorRequests = isSadran ? coordinatorRequestsQuery.data ?? [] : [];

  const boardRidesQuery = useBoardRides(departmentId, weekStart);
  const waitlistGroupsQuery = useWaitlistGroupsQuery(departmentId, weekStart);
  const carsQuery = useCars(departmentId);
  const maintenanceQuery = useMaintenanceBlocks(departmentId);
  const carLocationsQuery = useCarLocations(departmentId, weekStart);
  const carStartLocationsQuery = useCarStartLocations(departmentId, weekStart);
  const rideTypesQuery = useRideTypes(departmentId);
  const settingsQuery = useDepartmentSettings(departmentId);
  const recentlyWashedCarIds = useRecentlyWashedCarIds(departmentId);
  const changesQuery = useRideChanges(departmentId, weekStart, { scoped: true });

  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [selectedRideId, setSelectedRideId] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedWaitingId, setSelectedWaitingId] = useState<string | null>(null);
  // Swap cars on a day by dragging car names (REQ §13.92, owner batch 2026-09-24 S1).
  const [carSwapPair, setCarSwapPair] = useState<{ carA: string; carB: string } | null>(null);
  const [quickRequestSlot, setQuickRequestSlot] = useState<{
    carId: string;
    day: string;
    weekStart: string;
    time: string;
    /** "להיות בבית עד" from a two-tap span (owner 2026-10-11). */
    endTime?: string;
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
  // REQ item 149: show other people's changes to this week without a reload (Sadran: every change; members: what they can see).
  useWeekChangeWatch(departmentId, weekStart ? [weekStart] : [], isSadran ? "sadran" : "public", { realtime: isMyDepartment || isSadran, gate: !isSadranLoading });
  const homeDestinationId = (departmentsQuery.data ?? []).find((d) => d.id === departmentId)?.home_destination_id ?? null;

  const rides = boardRidesQuery.data ?? [];
  const editableOwnRequest = selectedRideId
    ? (myRequestsQuery.data ?? []).find((request) => request.ride?.id === selectedRideId && canEditRequest(request))
    : undefined;
  const myRequestIds = new Set((myRequestsQuery.data ?? []).map((request) => request.id));
  // REQ §13.127 (b): driver, a served request I made or filed, a named passenger (F3, 20260914120000_ride_passengers.sql)
  // or the owner of the ride's private car.
  function isMyRide(ride: BoardRide): boolean {
    const car = (carsQuery.data ?? []).find((c) => c.id === ride.car_id);
    return isRideRelated({ ride, profileId, myRequestIds, carOwnerId: car?.type === "temporary" ? car.owner_id : null });
  }
  // REQ §13.177 (c): painted as mine (purple) only through my own trips — not a ride I only filed for someone else.
  const myOwnRequestIds = ownRequestIds(myRequestsQuery.data ?? [], profileId);
  function isMyRideToPaint(ride: BoardRide): boolean {
    const car = (carsQuery.data ?? []).find((c) => c.id === ride.car_id);
    return isRideRelated({ ride, profileId, myRequestIds: myOwnRequestIds, carOwnerId: car?.type === "temporary" ? car.owner_id : null });
  }
  // No request of my own on the ride but I am related to it: edit the ride's driver request (the edit page asks the server).
  const relatedEditRequestId = !editableOwnRequest && selectedRideId
    ? (() => { const selected = rides.find((r) => r.id === selectedRideId); return selected && isMyRide(selected) ? relatedRequestIdToEdit(selected) : undefined; })()
    : undefined;
  // REQ §13.179 (a): anyone on a merged ride edits the shared ride — its main trip — not their own part of it.
  const mergedEditRequestId = selectedRideId
    ? (() => { const selected = rides.find((r) => r.id === selectedRideId); return selected && isMergedRide(selected) && isMyRide(selected) ? relatedRequestIdToEdit(selected) : undefined; })()
    : undefined;
  const editRequestIdForRide = mergedEditRequestId ?? editableOwnRequest?.id ?? relatedEditRequestId;
  const editHrefForRide = editRequestIdForRide ? paths.requests.edit(editRequestIdForRide) : undefined;
  // REQ §13.202: the ride of someone who named me their editor — its edit says whose it is, and I may remove it as theirs.
  const rideEditorsQuery = useRideEditorsQuery();
  const editorOwnerIds = new Set((rideEditorsQuery.data?.grantedToMe ?? []).filter((link) => link.departmentId === departmentId).map((link) => link.person.id));
  const editorOwnerOfEdit = editRequestIdForRide ? (myRequestsQuery.data ?? []).find((request) => request.id === editRequestIdForRide)?.editorOf ?? null : null;
  const editLabelForRide = editorOwnerOfEdit ? tv("rideDetail.editRequestOf", { name: editorOwnerOfEdit }) : he.rideDetail.edit;

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

  // `?day=<yyyy-MM-dd>` (a just-saved request's day, `overlayTargetPath`, or the day picked here): open that day once;
  // the member's own day picks after it win.
  const focusDay = searchParams.get("day");
  const [handledDayFocus, setHandledDayFocus] = useState<string | null>(null);
  if (focusDay && !focusGroupId && handledDayFocus !== focusDay) {
    setHandledDayFocus(focusDay);
    setSelectedDay(focusDay);
  }

  // A picked day goes into the URL (replace), so the request form opened from here remembers it as the page
  // underneath and closing it returns to this day (owner 2026-11-02).
  function selectDay(day: string) {
    setSelectedDay(day);
    setHandledDayFocus(day);
    const params = new URLSearchParams(searchParams);
    params.set("day", day);
    setSearchParams(params, { replace: true });
  }

  const dayGroups = weekStart ? groupByDay(rides, weekStart, (r) => r.starts_at ?? "") : [];
  const today = todayInJerusalem();
  const defaultDay = dayGroups.find((g) => g.date === today)?.date ?? dayGroups[0]?.date ?? null;
  const activeDay = dayGroups.some((g) => g.date === selectedDay) ? selectedDay : defaultDay;
  const activeDayRides = dayGroups.find((g) => g.date === activeDay)?.items ?? [];
  // Contested waiting-list groups (REQ §13.75, UX_FLOWS.md §3.5): one "בדיון" block/card per
  // still-open group on the displayed day, alongside the day's rides.
  const activeDayWaitlistGroups = (waitlistGroupsQuery.data ?? []).filter((group) => group.day === activeDay);
  // REQ §13.182: requests waiting for a car on published days, for members of the department, always on the siddur.
  // The header button (only while someone waits) counts the day's waiting requests, groups included, and scrolls to them.
  const waitlistWeek = isMyDepartment && (resolvedWeek?.phase === "published" || resolvedWeek?.phase === "live");
  const siddurWaitlistQuery = useSiddurWaitlistQuery(departmentId, weekStart, waitlistWeek);
  const activeDayWaiting = (siddurWaitlistQuery.data ?? []).filter((request) => request.day === activeDay);
  const waitingCount = activeDayWaiting.length + activeDayWaitlistGroups.reduce((sum, group) => sum + group.members.length, 0);
  const selectedWaiting = (siddurWaitlistQuery.data ?? []).find((request) => request.request_id === selectedWaitingId) ?? null;
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
  const waitlistButton = waitlistWeek && activeDayPublished && waitingCount > 0
    ? <WaitlistScrollButton count={waitingCount} onClick={scrollToWaitlist} />
    : null;
  // REQ §13.155: the "טרם פורסם" stamp, only in a week some of which is published.
  const stampUnpublished = !!activeDay && !activeDayPublished && (resolvedWeek?.published_days?.length ?? 0) > 0;
  const isLiveDay = isLiveWeek && activeDayPublished;
  const canEditWeek = isMyDepartment && activeDayPublished && (isLiveWeek || resolvedWeek?.phase === "published");
  // REQ §13.92 "Who": any department member may drag-swap car headers on a published day that
  // has not passed — the same publication gate `canEditWeek` already computes, plus "not past".
  const canSwapCarsOnActiveDay = canEditWeek && !!weekStart && activeDay !== null && activeDay >= today;
  // "+ נוסעים" (REQ §13.85): mirrors `is_week_public()` (DATA_MODEL §4.2) — week-level, not
  // per-day, since `add_ride_passengers()`'s own authorization checks the week's phase only.
  const weekIsPublic = !!resolvedWeek && (resolvedWeek.phase === "published" || resolvedWeek.phase === "live" || resolvedWeek.phase === "archived");
  const now = new Date();
  // REQ §13.169 (a): with the department's switch on, any member edits any request on any ride (one entry per request).
  const editLinksForRide = (() => {
    const selected = selectedRideId ? rides.find((r) => r.id === selectedRideId) : undefined;
    if (!settingsQuery.data?.anyone_edits_rides || !isMyDepartment || !selected || selected.status === "cancelled"
        || (selected.ends_at && Date.parse(selected.ends_at) <= now.getTime())) {
      return editHrefForRide ? [{ href: editHrefForRide, label: editLabelForRide }] : [];
    }
    const targets = rideEditTargets(selected);
    return targets.map((target) => ({
      href: paths.requests.edit(target.requestId),
      label: targets.length === 1 ? he.rideDetail.edit : tv("rideDetail.editRequestOf", { name: target.requester }),
    }));
  })();
  const dayFreeWindows = useDayFreeWindows(departmentId, isLiveDay ? weekStart : undefined, isLiveDay ? (activeDay ?? undefined) : undefined, now);

  const myPrivateCarIds = new Set((carsQuery.data ?? [])
    .filter((car) => car.type === "temporary" && car.owner_id === profileId && car.status === "active").map((car) => car.id));

  /**
   * Owner 2026-10-11: a two-tap span on an empty part of a car column (first tap = start, second = end) opens the
   * request form with "לצאת ב־<start>", "להיות בבית עד <end>" and that car as the preferred car (a shared car only).
   * The same slot twice gives only the start, with the form's default length.
   */
  function handleSlotRange(carId: string, startMinutes: number, endMinutes: number) {
    if (!weekStart || !activeDay) return;
    const time = formatMinutes(startMinutes);
    const endTime = endMinutes > startMinutes ? formatMinutes(endMinutes) : undefined;
    // REQ §13.183 (f): two taps on a "חסר רכב" column - a new request for those hours, no car (placed if one is free, else it waits).
    if (carId.startsWith(WAITING_LANE_PREFIX)) {
      navigate(paths.requests.new({ week: weekStart, day: activeDay, time, end: endTime, waitlist: true }), requestLinkProps);
      return;
    }
    if (carId.startsWith("phantom:")) return;
    // Owner 2026-11-03: my own private car's row - the form with that car chosen (a round trip lands on it directly).
    if (myPrivateCarIds.has(carId)) {
      navigate(paths.requests.new({ week: weekStart, day: activeDay, time, end: endTime, car: carId }), requestLinkProps);
      return;
    }
    if (isLiveDay) {
      setQuickRequestSlot({
        carId, day: activeDay, weekStart, time, endTime,
        cars: dayFreeWindows.cars, freeWindows: dayFreeWindows.freeWindows, awayWindows: dayFreeWindows.awayWindows,
      });
    } else {
      const sharedCar = carsQuery.data?.some((car) => car.id === carId && car.type === "shared") ? carId : undefined;
      navigate(paths.requests.new({ week: weekStart, day: activeDay, time, end: endTime, car: sharedCar }), requestLinkProps);
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
    isRideDayEditable(selectedRide.starts_at, now) &&
    (resolvedWeek?.phase !== "archived") &&
    (isSadran || (canEditWeek && ownsSelectedRide) || !!profileQuery.data?.is_admin);
  const pendingChanges = changesQuery.data ?? [];
  const shadowedRideIds = new Set(pendingChanges.flatMap((c) => [c.ride_id, ...c.parties.map((p) => p.ride_id)]));
  // REQ §13.108 D1: the shown week's override of the turnaround buffer wins over the department's.
  const turnaroundMinutes = effectiveWeekSettings(settingsQuery.data, resolvedWeek).turnaroundMinutes;
  const tightRideIds = tightRideIdsOf(boardRidesQuery.data ?? [], turnaroundMinutes, homeDestinationId, carsQuery.data ?? []);

  // Moving / resizing my own ride — shared with the "my rides" week view (owner 2026-10-11).
  const rideMoves = useMemberRideMoves({
    departmentId, weekStart, week: resolvedWeek, profileId, myRequestIds, isMember: isMyDepartment, now,
    onDone: () => setSelectedRideId(null),
  });
  const { ownsEditableRide, canDragRide, saveMove, moveRide } = rideMoves;
  // REQ §13.183: a waiting round trip I may edit (mine, the Sadran, the "anyone edits rides" switch) drags onto a car.
  const waitingDrop = useWaitingDrop(departmentId, weekStart);
  const waitingOf = (gridId: string) => {
    const requestId = waitingRequestIdOf(gridId);
    return requestId ? activeDayWaiting.find((request) => request.request_id === requestId) : undefined;
  };
  const myPrivateCars = (carsQuery.data ?? []).filter((car) => myPrivateCarIds.has(car.id));
  const mayEditWaiting = (request: { is_mine: boolean }) => request.is_mine || isSadran || !!settingsQuery.data?.anyone_edits_rides;
  // A private car's owner may also put anyone's waiting round trip on that car (REQ §13.183).
  const canDragWaiting = (gridId: string) => {
    const request = waitingOf(gridId);
    return !!request && (mayEditWaiting(request) || myPrivateCars.length > 0) && waitingDrop.canDrag(request);
  };
  // Owner 2026-10-30: edit mode (the pencil) - off, a ride drags only after a long press.
  const [editMode, setEditMode] = useEditMode();
  const onDragHint = useDragHint();
  const sheetCarActions = useRideSheetCarActions({ departmentId, profileId, myRequestIds, week: resolvedWeek, isMember: isMyDepartment, now });

  const selectedCar = selectedRide ? (carsQuery.data ?? []).find((c) => c.id === selectedRide.car_id) ?? null : null;
  // R17B11: where the car is when this ride starts — the away row covering that moment, not the car's first one.
  const selectedLocation = selectedRide?.starts_at
    ? carLocationsQuery.data?.find((l) => {
      const at = Date.parse(selectedRide.starts_at!);
      return l.car_id === selectedRide.car_id && !!l.away_from && Date.parse(l.away_from) <= at
        && (!l.away_until || Date.parse(l.away_until) >= at);
    })?.location_name ?? null
    : null;

  const destinationsQuery = useDestinations(departmentId);
  const weekGridCars: WeekGridCar[] = (() => {
    const destinationNameById = new Map((destinationsQuery.data ?? []).map((d) => [d.id, d.name]));
    return (carsQuery.data ?? []).map((c) => ({
      id: c.id,
      name: siddurCarName(c),
      group: c.type,
      // R2B14: the away place only on the days the car is actually away (at the selected day's start).
      locationBadge: !(activeDay ?? weekStart) ? undefined : carAwayPlaceAtDayStart({
        carId: c.id,
        dayStartIso: fromZonedTime(`${activeDay ?? weekStart}T00:00:00`, TZ).toISOString(),
        rides: boardRidesQuery.data ?? [],
        weekStartLocationId: carStartLocationsQuery.data?.[c.id],
        baseLocationId: c.base_location_id,
        homeId: homeDestinationId,
        names: destinationNameById,
      }),
      // REQUIREMENTS §13.93: the car's own base, shown only when it isn't the department home.
      baseBadge: c.base_location_id && c.base_location_id !== homeDestinationId
        ? tv("sadranBoard.carBase", { place: destinationNameById.get(c.base_location_id) ?? "" })
        : undefined,
    }));
  })();
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
      // REQUIREMENTS §13.93 "Multi-stop rides" Display: "· N עצירות" appended only when the
      // ride actually serves a request with stops (same marker as the Sadran board).
      label: (() => {
        const base = (!servedOf(r).length && r.notes) || (homeDestinationId && r.origin_id && r.destination_id
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
              autoRelocation: !!r.auto_relocation,
              carMove: r.pin_reason === "CAR_MOVE",
              startsAt: r.starts_at ?? undefined,
            })
          : (r.destination_name ?? ""));
        const via = viaLabel(rideViaNames(r));
        return via ? `${base} · ${via}` : base;
      })(),
      rideTypeCode: representativeRideTypeCode(servedOf(r)),
      description: [servedOf(r).length ? r.notes : null, ridePublicDetails(servedOf(r), { includeCompanions: !isSadran, addedNames: addedNamesOf(r) })].filter(Boolean).join("\n"),
      passengerSummary: isSadran ? ridePassengerSummary(servedOf(r), r.needs_driver ? null : r.driver_name, { addedNames: addedNamesOf(r) }) : undefined,
      coordinatorNotes: rideCoordinatorNotes(servedOf(r), coordinatorRequests),
      shadowed: shadowedRideIds.has(r.id as string),
      needsDriver: !!r.needs_driver,
      isMine: isMyRideToPaint(r),
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

  // A private (temporary) car is shown only on days it has a ride (REQ §13.80, owner 2026-09-14) — except to its owner.
  const weekGridVisibleCars = hideIdleTemporaryCars(weekGridCars, weekGridRides, myPrivateCarIds);
  const waitingGrid = activeDay
    ? waitingLanes(activeDayWaiting, activeDay, minutesSinceMidnight,
        (lane) => (lane === 0 ? he.waitlist.siddurLane : tv("waitlist.siddurLaneN", { number: String(lane + 1) })), waitingLabel)
    : { cars: [], rides: [] };
  // REQ §13.114: maintenance bands in the car column; draggable by the car's current responsible person, the Sadran, the admin.
  // Owner 2026-10-11: the same hatched "car is at X" band as the board — not from home, but free for someone at X.
  const awayBands = activeDay ? awayBandBlocks(carLocationsQuery.data ?? [], activeDay, (place) => tv("siddur.awayBand", { place })) : [];
  const maintenanceEditing = useMaintenanceGridEditing({ departmentId, blocks: maintenanceQuery.data ?? [], cars: carsQuery.data ?? [], day: activeDay });

  // The pencil shows only when this day has something this member may drag.
  const canDragSomething = canEditWeek && (canSwapCarsOnActiveDay || weekGridRides.some((ride) => canDragRide(ride.id))
    || waitingGrid.rides.some((ride) => canDragWaiting(ride.id))
    || maintenanceEditing.gridBlocks.some((block) => block.editable));
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

  const memberRideEditor = selectedRide?.id && ownsEditableRide(selectedRide.id) && !editLinksForRide.length
    ? <MemberRideEditor key={`${selectedRide.id}:${selectedRide.version}:editor`} ride={selectedRide} cars={carsQuery.data ?? []} viewerId={profileId} saving={rideMoves.saving} onSave={(move) => void saveMove(move)} />
    : null;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 pb-24 lg:max-w-none">
      {/* On a computer the published siddur uses the whole width (owner 2026-10-06). */}
      {/* Mobile header (below `md`): the title is itself the this-week/next-week switcher; the
          eye icon collapses every `TableViewControls` option plus "show early hours" into one
          menu (UX_FLOWS.md member siddur "mobile header"). */}
      <div className="flex items-center justify-between gap-2 py-2 md:hidden">
        {/* Keeps a stable, discoverable page heading for assistive tech (and existing
            navigation-by-heading checks) even though the visible title text now switches
            between "השבוע"/"שבוע הבא" as the week switcher itself. */}
        <h1 className="sr-only">{t("screen.siddur.title")}</h1>
        <WeekSwitcherTitle resolution={thisNextWeek} activeWeekStart={weekStart} onSelect={(next) => goTo(departmentId as string, next)} onArchive={goToArchive} />
        <div className="flex items-center gap-2">
          {/* O30-2: the phone's list view drags nothing — the pencil only with the table. */}
          {canDragSomething && tableView ? <EditModeButton on={editMode} onChange={setEditMode} /> : null}
          {waitlistButton}
          {departmentId ? <LongRangeMenu departmentId={departmentId} /> : null}
          <SiddurDisplayMenu
            table={tableView}
            onTableChange={setTableView}
            zoom={tableZoom}
            onZoomChange={setTableZoom}
            showEarlyHours={showEarlyHours}
            onShowEarlyHoursChange={setShowEarlyHours}
          />
        </div>
      </div>
      {departmentSwitcher ? <div className="md:hidden">{departmentSwitcher}</div> : null}

      <div className="hidden md:block">
        <PageHeader
          title={t("screen.siddur.title")}
          actions={departmentSwitcher ?? undefined}
        />
      </div>

      {!isMyDepartment ? <p className="text-xs text-muted-foreground">{he.siddur.otherDeptNote}</p> : null}
      {viewingArchivedWeek ? <p className="text-xs text-muted-foreground">{he.siddur.archivedWeekHint}</p> : null}

      {departmentId ? (
        <div className="hidden md:block" data-testid="siddur-desktop-week-switcher">
          <WeekSwitcherTitle resolution={thisNextWeek} activeWeekStart={weekStart} onSelect={(next) => goTo(departmentId, next)} onArchive={goToArchive} triggerTestId="siddur-week-switcher-desktop" />
        </div>
      ) : null}

      {!resolvedWeek ? (
        <EmptyState icon={CalendarDays} message={he.requestsList.empty} />
      ) : resolvedWeek.phase === "open" || resolvedWeek.phase === "solving" || resolvedWeek.phase === "upcoming" ? (
        <EmptyState
          icon={Inbox}
          message={tv("siddur.notPublishedYet", { weekLabel: formatWeekRangeLabel(resolvedWeek.week_start) })}
          action={
            <>
              <RequestDeadlineNote week={resolvedWeek} className="text-sm" />
              <a href={paths.my()} className="text-sm font-medium text-primary underline">
                {he.siddur.notPublishedAction}
              </a>
            </>
          }
        />
      ) : (
        <>
          {/* Desktop: the same display menu as mobile; "show early hours" lives only here. */}
          <div className="hidden md:flex md:justify-end md:gap-2">
            {/* Below lg without the table this is the list view (see the day list below). */}
            {canDragSomething ? <span className={tableView ? "contents" : "hidden lg:contents"}><EditModeButton on={editMode} onChange={setEditMode} /></span> : null}
            {waitlistButton}
            {departmentId ? <LongRangeMenu departmentId={departmentId} /> : null}
            <SiddurDisplayMenu
              table={tableView}
              onTableChange={setTableView}
              zoom={tableZoom}
              onZoomChange={setTableZoom}
              showEarlyHours={showEarlyHours}
              onShowEarlyHoursChange={setShowEarlyHours}
            />
          </div>
          <div className={cn("theme-grid-neutral bg-background", tableView ? "hidden" : "lg:hidden")}>
            <WeekStrip weekStart={weekStart as string} counts={dayCounts} selected={activeDay ?? ""} onSelect={selectDay} />
            {/* Owner 2026-10-26: an unpublished day is stamped all over, not a banner one can scroll past. */}
            <div className={cn("relative mt-3 space-y-2", stampUnpublished && "min-h-[60vh]")}>
              {stampUnpublished ? <DraftWatermark /> : null}
              {isMyDepartment ? (
                <div className="grid grid-cols-2 gap-2">
                  {departmentId ? <CarNowButton departmentId={departmentId} className="w-full" /> : null}
                  {activeDayPublished && (resolvedWeek?.phase === "published" || isLiveWeek) && weekStart && activeDay ? (
                    <Button type="button" variant="outline" className="w-full" onClick={() => navigate(paths.requests.new({ week: weekStart, day: activeDay, waitlist: true }), requestLinkProps)}>
                      {tv("siddur.waitlistForDay", { day: weekdayLabel(`${activeDay}T12:00:00Z`, "short") })}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {boardRidesQuery.isLoading ? (
                <CardListSkeleton />
              ) : activeDayRides.length === 0 && freeGapRows.length === 0 && activeDayWaitlistGroups.length === 0 && activeDayWaiting.length === 0 ? (
                <EmptyState icon={CalendarDays} message={he.siddur.noRides} />
              ) : (
                <>
                  {activeDayWaitlistGroups.map((group) => (
                    <WaitlistGroupCard key={group.id} group={group} onClick={() => setSelectedGroupId(group.id)} />
                  ))}
                  {activeDayWaiting.map((request) => (
                    <WaitingRequestCard key={request.request_id} request={request} onClick={() => setSelectedWaitingId(request.request_id)} />
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
                    description: [servedOf(r).length ? r.notes : null, ridePublicDetails(servedOf(r), { includeCompanions: !isSadran, addedNames: addedNamesOf(r) })].filter(Boolean).join("\n"),
                    passengerSummary: isSadran ? ridePassengerSummary(servedOf(r), r.needs_driver ? null : r.driver_name, { addedNames: addedNamesOf(r) }) : undefined,
                    coordinatorNotes: rideCoordinatorNotes(servedOf(r), coordinatorRequests),
                    driverName: r.driver_name,
                    isChauffeur: !!r.is_chauffeur,
                    needsDriver: !!r.needs_driver,
                    isMine: isMyRideToPaint(r),
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
            <WeekStrip weekStart={weekStart as string} counts={dayCounts} selected={activeDay ?? ""} onSelect={selectDay} />
            <RideTypeLegend
              types={(rideTypesQuery.data ?? []).map((rt) => ({ code: rt.code, nameHe: rt.name_he }))}
            />
            <div className="mt-3">
              <WeekGrid
                recentlyWashedCarIds={recentlyWashedCarIds}
                blocks={[...maintenanceEditing.gridBlocks, ...awayBands]}
                onBlockChange={maintenanceEditing.onBlockChange}
                onBlockClick={maintenanceEditing.onBlockClick}
                zoom={tableZoom}
                onZoomChange={setTableZoom}
                cars={[...weekGridVisibleCars, ...waitingGrid.cars]}
                rides={[...weekGridRides, ...waitingGrid.rides]}
                dayStartMinutes={dayStartMinutes}
                dayEndMinutes={dayEndMinutes}
                initialScrollMinutes={initialGridScrollMinutes}
                readOnly={!canEditWeek}
                draggable={canEditWeek && !rideMoves.saving && !waitingDrop.saving}
                canDragRide={(ride) => (waitingRequestIdOf(ride.id) ? canDragWaiting(ride.id) : canDragRide(ride.id))}
                canResizeRide={(ride) => ownsEditableRide(ride.id)}
                holdToDrag={!editMode}
                onDragHint={onDragHint}
                isDropTargetValid={(rideId, carId, startMinutes, endMinutes) => (waitingRequestIdOf(rideId)
                  ? weekGridVisibleCars.some((car) => car.id === carId) && (myPrivateCarIds.has(carId) || mayEditWaiting(waitingOf(rideId) ?? { is_mine: false }))
                  : rideMoves.isValidTarget(rideId, carId, startMinutes, endMinutes))}
                onRideDrop={(rideId, carId, startMinutes) => {
                  const waiting = waitingOf(rideId);
                  const car = weekGridVisibleCars.find((c) => c.id === carId);
                  if (waiting) { if (car) waitingDrop.drop(waiting, car.id, car.name, startMinutes); }
                  else moveRide(rideId, carId, startMinutes);
                }}
                onRideResize={(rideId, edge, minutes) => {
                  const ride = weekGridRides.find((r) => r.id === rideId);
                  if (ride) moveRide(rideId, ride.carId, edge === "start" ? minutes : ride.startMinutes, edge === "end" ? minutes : ride.endMinutes);
                }}
                onRideClick={(rideId) => {
                  const waitingId = waitingRequestIdOf(rideId);
                  if (waitingId) setSelectedWaitingId(waitingId);
                  else setSelectedRideId(rideId);
                }}
                onSlotRange={isMyDepartment ? handleSlotRange : undefined}
                rangeResetKey={activeDay ?? undefined}
                enableCarReport
                onOpenCarPage={(carId) => navigate(paths.car(carId))}
                discussionBlocks={weekGridDiscussionBlocks}
                onDiscussionClick={setSelectedGroupId}
                canSwapCars={canSwapCarsOnActiveDay}
                onCarSwap={(carA, carB) => setCarSwapPair({ carA, carB })}
                watermark={stampUnpublished}
              />
            </div>
          </div>
        </>
      )}

      {carSwapPair && departmentId && weekStart && activeDay ? (
        <CarSwapDialog
          open
          onOpenChange={(open) => !open && setCarSwapPair(null)}
          departmentId={departmentId}
          weekStart={weekStart}
          day={activeDay}
          carA={{ id: carSwapPair.carA, name: weekGridCars.find((c) => c.id === carSwapPair.carA)?.name ?? "" }}
          carB={{ id: carSwapPair.carB, name: weekGridCars.find((c) => c.id === carSwapPair.carB)?.name ?? "" }}
        />
      ) : null}
      {maintenanceEditing.dialog}
      <RideDetailSheet
        {...sheetCarActions.sheetProps(selectedRide, () => setSelectedRideId(null))}
        {...(selectedRide?.id && ownsEditableRide(selectedRide.id) ? { moveToCarOptions: [] } : {})}
        ride={selectedRide}
        weekRides={rides}
        coordinatorNotes={selectedRide ? rideCoordinatorNotes(servedOf(selectedRide), coordinatorRequests) : undefined}
        canEditPublicNotes={canEditPublicNotes}
        showAddPassengers={!!selectedRide && selectedRide.status !== "cancelled" && weekIsPublic}
        car={selectedCar}
        locationBadge={selectedLocation}
        homeDestinationId={homeDestinationId}
        onOpenChange={(open) => !open && setSelectedRideId(null)}
        onRemoveOwnRide={selectedRide?.id && (selectedRide.driver_id === profileId || (!!selectedRide.driver_id && editorOwnerIds.has(selectedRide.driver_id))) && !volunteerDriverOf(selectedRide) && selectedRide.version != null
          ? () => cancelRideMutation.mutate({ rideId: selectedRide.id!, expectedVersion: selectedRide.version!, reason: "CANCELLED_BY_MEMBER", asEditor: selectedRide.driver_id !== profileId }, { onSuccess: () => setSelectedRideId(null) })
          : undefined}
        removingOwnRide={cancelRideMutation.isPending}
        onRemoveMe={(() => {
          const myKey = selectedRide ? myRidePersonKey(selectedRide, profileId) : null;
          if (!selectedRide?.id || !myKey || selectedRide.version == null || !selectedRide.department_id || !selectedRide.week_start) return undefined;
          const { id, version, department_id, week_start } = selectedRide;
          return () => removeMeMutation.mutate({ rideId: id, expectedVersion: version, key: myKey, departmentId: department_id, weekStart: week_start }, { onSuccess: () => setSelectedRideId(null) });
        })()}
        removingMe={removeMeMutation.isPending}
        editRequestLinks={editLinksForRide}
        editor={selectedRide?.needs_driver && canEditWeek && selectedRide.ends_at && Date.parse(selectedRide.ends_at) > now.getTime() ? (
          <VolunteerDriverPanel ride={selectedRide} onDone={() => setSelectedRideId(null)}
            canDrive={!profileQuery.data?.does_not_drive && !isDrivenOnRide(selectedRide, profileId)} />
        ) : selectedRide && canEditWeek && volunteerDriverOf(selectedRide) ? (
          // REQ §13.174: the volunteer steps down, or someone else takes the wheel from them.
          <>
            <VolunteerDriverChange ride={selectedRide} viewerId={profileId} now={now.getTime()} onDone={() => setSelectedRideId(null)}
              canDrive={!profileQuery.data?.does_not_drive && !isDrivenOnRide(selectedRide, profileId)} />
            {memberRideEditor}
          </>
        ) : memberRideEditor ?? undefined}
      />

      <ConfirmDialog
        open={!!waitingDrop.pending}
        onOpenChange={(open) => { if (!open) waitingDrop.cancel(); }}
        title={he.waitlist.dropConfirmTitle}
        confirmLabel={he.waitlist.dropConfirm}
        loading={waitingDrop.saving}
        onConfirm={waitingDrop.confirm}
      >
        <ul className="list-disc space-y-1 ps-5 text-sm" data-testid="waiting-drop-warnings">
          {(waitingDrop.pending?.warnings ?? []).map((warning) => <li key={warning.code}>{waitingDropWarningText(warning)}</li>)}
        </ul>
      </ConfirmDialog>
      <WaitingRequestSheet
        request={selectedWaiting}
        myCars={selectedWaiting && waitingDrop.canDrag(selectedWaiting) ? myPrivateCars : []}
        onAssignToCar={(carId, carName) => {
          if (!selectedWaiting) return;
          waitingDrop.drop(selectedWaiting, carId, carName, minutesSinceMidnight(selectedWaiting.starts_at));
          setSelectedWaitingId(null);
        }}
        myVersion={(myRequestsQuery.data ?? []).find((request) => request.id === selectedWaitingId)?.version}
        onOpenChange={(open) => !open && setSelectedWaitingId(null)}
      />
      <WaitlistGroupSheet
        group={selectedWaitlistGroup}
        departmentId={departmentId as string}
        weekStart={weekStart as string}
        profileId={profileId}
        canManageWeek={isSadran}
        onOpenChange={(open) => !open && setSelectedGroupId(null)}
        myRequests={myRequestsQuery.data ?? []}
      />

      {rideMoves.makeRoomElement}
      <ConfirmDialog {...rideMoves.ownCarDialog} />
      {rideMoves.memberMergeElement}

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
          initialEndTime={quickRequestSlot.endTime}
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
