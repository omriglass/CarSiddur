import { CalendarDays } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { useRequestLinkProps } from "@/app/overlayState";
import { paths } from "@/app/routes";
import { todayInJerusalem } from "@/components/dateFieldDates";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { formatMinutes, MAX_MINUTES } from "@/components/timeField15Format";
import { WeekGrid, type WeekGridCar } from "@/components/WeekGrid";
import { useCars } from "@/features/fleet/hooks";
import { useDepartmentSettings } from "@/features/sadran/hooks";
import { parseTimeToMinutes } from "@/features/solverBridge/buildSolverInput";
import { CalendarDialog } from "@/features/calendar/CalendarDialog";
import { useCalendar } from "@/features/calendar/useCalendar";
import { useCalendarAmbientBlocks } from "@/features/calendar/useCalendarAmbientBlocks";
import { useGoogleCalendar } from "@/features/calendar/useGoogleCalendar";
import { selectRelatedRides, type RelatedRideLabel } from "@/features/rides/myRides";
import { carHandoverLines, carHandoverNotes, neighboursFromRides } from "@/features/rides/carHandover";
import { useCarNeighboursQuery } from "@/features/rides/hooks";
import { servedOf } from "@/features/rides/servedOf";
import { tightRideIdsOf } from "@/features/rides/tightSchedule";
import { effectiveWeekSettings } from "@/lib/weekSettings";
import { useMemberRideMoves } from "@/features/rides/useMemberRideMoves";
import { useBoardRides } from "@/features/siddur/hooks";
import { pastWeeks, isPastWeek } from "@/features/siddur/pastWeeks";
import { resolveThisNextWeek } from "@/features/siddur/thisNextWeek";
import { useSiddurDisplayPrefs } from "@/features/siddur/useSiddurDisplayPrefs";
import type { BoardRide, Week } from "@/features/siddur/api";
import { he, t } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { dateKey } from "@/lib/time";

import type { MyRequestRow, TemplateSuggestion } from "../api";
import { useMoveRequestMutation, useTemplateSuggestionsQuery } from "../hooks";
import { toastSubmitOutcome } from "../submitOutcome";
import { minutesOfDay, weekDayKeys } from "./dayColumns";
import { useNowQuarter } from "./useNowQuarter";
import {
  isMyBoardRide,
  requestBlocks,
  rideBlocks,
  rideRouteLabel,
  rideWithCarLabel,
  suggestionBlocks,
  visibleStartMinutes,
  withLanes,
  type MyWeekTarget,
} from "./myWeekItems";
import { MyWeekDisplayMenu } from "./MyWeekDisplayMenu";
import { RequestDeadlineNote } from "../components/RequestDeadlineNote";
import { MyWeekSwitcher } from "./MyWeekSwitcher";

/** Weeks in which a tap on empty space may start a request (never `solving`, `upcoming` or any past week). */
const REQUEST_PHASES = new Set<Week["phase"]>(["open", "published", "live"]);

interface MyWeekViewProps {
  departmentId: string | undefined;
  homeDestinationId: string | null | undefined;
  profileId: string | undefined;
  /** Every request of mine (the same rows the list shows); unplaced ones are drawn as blocks. */
  requests: readonly MyRequestRow[];
  weeks: readonly Week[];
  /** The week `profiles.home_week_preference` resolves to (`resolveHomeWeek`); the grid opens on it unless `?week=` says otherwise. */
  homeWeekStart: string | undefined;
  /** The member may file requests in this department (`useActiveDepartment().canSubmit`). */
  canSubmit: boolean;
  /** A tap does what the same item does on the list view — the page owns those flows. */
  onTarget: (target: MyWeekTarget) => void;
  /** `/my/archive`: past weeks only, read-only; no view toggle, the switcher lists the past weeks. */
  archive?: boolean;
  /** The list / week choice of the eye menu (current view only). */
  onViewChange?: (view: "list" | "week") => void;
  /** Owner 2026-10-16: the eye menu's "children's rides" option (read-only extras); `childIds` = my `child_guardians`. */
  showKidsRides?: boolean;
  onShowKidsRidesChange?: (show: boolean) => void;
  childIds?: ReadonlySet<string>;
  /** The other guardians of my children (`my_co_guardians`), for the same option. */
  guardianIds?: ReadonlySet<string>;
}

/**
 * `/my?view=week` — the member's own week as a siddur-like grid with one column per day (owner 2026-10-11,
 * UX_FLOWS.md "/my week view"). My rides (with their car in the label), my unplaced requests, repeating-request
 * suggestions and proposals waiting for my answer, each on its exact day and times; overlapping items sit side by side.
 * Past weeks (the archive) show rides only, read-only. Layout comes from `WeekGrid`; this component only maps data to it.
 */
export function MyWeekView({ departmentId, homeDestinationId, profileId, requests, weeks, homeWeekStart, canSubmit, onTarget, archive = false, onViewChange, showKidsRides = false, onShowKidsRidesChange, childIds, guardianIds }: MyWeekViewProps) {
  const navigate = useNavigate();
  const requestLinkProps = useRequestLinkProps();
  const [searchParams, setSearchParams] = useSearchParams();
  const today = todayInJerusalem();
  const { thisWeekStart } = resolveThisNextWeek(weeks, today);
  const newestPast = pastWeeks(weeks.filter((w) => w.phase !== "upcoming"), today)[0]?.week_start;
  const weekStart = searchParams.get("week") ?? (archive ? newestPast : homeWeekStart) ?? thisWeekStart;
  const week = weeks.find((w) => w.week_start === weekStart) ?? null;
  const isPast = archive || isPastWeek({ week_start: weekStart, phase: week?.phase ?? "open" }, today);
  const acceptsRequests = canSubmit && !!week && !isPast && REQUEST_PHASES.has(week.phase);

  const { tableZoom, setTableZoom } = useSiddurDisplayPrefs();
  const nowQuarter = useNowQuarter();
  const ridesQuery = useBoardRides(departmentId, weekStart);
  const carsQuery = useCars(departmentId);
  const settingsQuery = useDepartmentSettings(departmentId);
  const suggestionsQuery = useTemplateSuggestionsQuery();
  // Experimental (owner 2026-10-12): the member's Google calendar behind the week, current weeks only.
  const calendar = useGoogleCalendar();
  const [calendarOpen, setCalendarOpen] = useState(false);
  const ambientBlocks = useCalendarAmbientBlocks(calendar.available && !archive ? weekStart : undefined);
  const { displayPrefs: calendarPrefs } = useCalendar();
  // Owner 2026-10-11: my own rides drag / resize here exactly as on the siddur (one shared implementation) — within the
  // ride's own day and car, since the columns here are days.
  const rideMoves = useMemberRideMoves({ departmentId, weekStart, week, profileId, myRequestIds: new Set(requests.map((request) => request.id)), isMember: canSubmit && !isPast, now: new Date() });
  // Owner 2026-10-12: my unplaced requests drag / resize too, onto any day of the shown week.
  const moveRequest = useMoveRequestMutation();

  const dayKeys = useMemo(() => weekDayKeys(weekStart), [weekStart]);
  const boardStartMinutes = settingsQuery.data?.board_start_time ? parseTimeToMinutes(settingsQuery.data.board_start_time) : 6 * 60;

  // "!" be-back-on-time lines (owner 2026-10-16): the server view on published days, the client mirror elsewhere.
  const myHandoverRideIds = useMemo(() => {
    const ids = new Set(requests.map((row) => row.id));
    return (ridesQuery.data ?? []).flatMap((ride) => (ride.id && isMyBoardRide(ride, profileId, ids) ? [ride.id] : []));
  }, [profileId, requests, ridesQuery.data]);
  const serverNeighbours = useCarNeighboursQuery(myHandoverRideIds).data;

  const entries = useMemo(() => {
    const myRequestIds = new Set(requests.map((row) => row.id));
    // Owner 2026-10-16: the siddur's tight-schedule marker on my rides (also on an unpublished day I manage).
    const tightIds = tightRideIdsOf(ridesQuery.data ?? [], effectiveWeekSettings(settingsQuery.data, week).turnaroundMinutes, homeDestinationId, carsQuery.data ?? []);
    const related = showKidsRides && childIds?.size
      ? selectRelatedRides(ridesQuery.data ?? [], { profileId, childIds, guardianIds: guardianIds ?? new Set() }, myRequestIds)
      : new Map<string, RelatedRideLabel[]>();
    const carNameById = new Map((carsQuery.data ?? []).map((car) => [car.id, car.name]));
    const mine = (ridesQuery.data ?? []).filter((ride: BoardRide) => isMyBoardRide(ride, profileId, myRequestIds) || (!!ride.id && related.has(ride.id)));
    const myRequestsById = new Map(requests.map((row) => [row.id, row]));
    const turnaround = effectiveWeekSettings(settingsQuery.data, week).turnaroundMinutes;
    const handoverLines = new Map<string, string[]>();
    for (const ride of mine) {
      if (!ride.id || !ride.starts_at || !ride.ends_at || related.has(ride.id)) continue;
      const neighbours = serverNeighbours?.get(ride.id) ?? neighboursFromRides(ridesQuery.data ?? [], ride.id, turnaround);
      const lines = carHandoverLines(carHandoverNotes(neighbours, profileId, profileId ? [profileId] : []), { startsAt: ride.starts_at, endsAt: ride.ends_at });
      if (lines.length) handoverLines.set(ride.id, lines.map((line) => `${line.before}${line.day ? `${line.day} ` : ""}${line.time}${line.after}`));
    }
    const blocks = rideBlocks(mine, dayKeys, (ride) => rideWithCarLabel(ride.car_id ? carNameById.get(ride.car_id) ?? "" : "", rideRouteLabel(ride, homeDestinationId)), myRequestsById, { tightIds, related, handoverLines });
    if (!isPast) {
      const sameDepartment = requests.filter((row) => row.departmentId === departmentId && row.weekStart === weekStart);
      const servedRequestIds = new Set(mine.flatMap((ride) => servedOf(ride).flatMap((entry) => (entry.request_id ? [entry.request_id] : []))));
      blocks.push(...requestBlocks(sameDepartment, dayKeys, homeDestinationId, undefined, servedRequestIds));
      const suggestions = (suggestionsQuery.data ?? []).filter((s: TemplateSuggestion) => s.departmentId === departmentId && s.weekStart === weekStart);
      blocks.push(...suggestionBlocks(suggestions, dayKeys, homeDestinationId));
    }
    return withLanes(blocks);
  }, [carsQuery.data, childIds, dayKeys, guardianIds, departmentId, homeDestinationId, isPast, profileId, requests, ridesQuery.data, showKidsRides, serverNeighbours, settingsQuery.data, suggestionsQuery.data, week, weekStart]);

  const targetById = useMemo(() => new Map(entries.map((entry) => [entry.block.id, entry.target])), [entries]);
  const dayColumns: WeekGridCar[] = dayKeys.map((key) => ({ id: key, name: formatDayDate(`${key}T12:00:00Z`), today: key === today }));

  /** A block id is `ride:<id>` (a ride's other-day segments carry `~n` and never move); anything else is not a ride. */
  function rideOf(blockId: string): BoardRide | null {
    if (!blockId.startsWith("ride:") || blockId.includes("~")) return null;
    return (ridesQuery.data ?? []).find((ride) => ride.id === blockId.slice("ride:".length)) ?? null;
  }
  function canMove(blockId: string): boolean {
    const ride = rideOf(blockId);
    // Read-only extras (my children's rides) are not mine, so `ownsEditableRide` already refuses them.
    return !!ride?.id && rideMoves.ownsEditableRide(ride.id);
  }
  /** Only the ride's own day: a drop on another day's column is refused (the siddur rule — same local day). */
  function sameDayCar(ride: BoardRide, dayKey: string): string | null {
    return ride.starts_at && ride.car_id && dateKey(ride.starts_at) === dayKey ? ride.car_id : null;
  }

  /** An unplaced request block (`request:<id>` / `waiting:<id>`; a midnight-crossing block's later segments never move). */
  function requestOf(blockId: string): MyRequestRow | null {
    if (blockId.includes("~")) return null;
    const match = /^(request|waiting):(.+)$/.exec(blockId);
    return match ? requests.find((row) => row.id === match[2]) ?? null : null;
  }
  /**
   * Movable: the week takes requests, and the request is a plain single-day one — not a multi-day series, not a time
   * window ("יש לי חלון זמן", its block is not its times), not crossing midnight, and not on a day already over.
   */
  function canMoveRequest(row: MyRequestRow): boolean {
    const anchor = row.departAt ?? row.returnAt;
    if (!acceptsRequests || !anchor || row.seriesId || row.durationLocked) return false;
    if (row.departAt && row.returnAt && dateKey(row.departAt) !== dateKey(row.returnAt)) return false;
    return dateKey(anchor) >= today;
  }
  function canDrag(blockId: string): boolean {
    const row = requestOf(blockId);
    return row ? canMoveRequest(row) : canMove(blockId);
  }
  /** Only a request with both ends can be stretched; a one-way block is a fixed hour. */
  function canResize(blockId: string): boolean {
    const row = requestOf(blockId);
    return row ? canMoveRequest(row) && !!row.departAt && !!row.returnAt : canMove(blockId);
  }
  function requestTargetValid(dayKey: string, start: number, end: number): boolean {
    if (!dayKeys.includes(dayKey) || dayKey < today || start < 0 || end > 24 * 60) return false;
    return dayKey !== today || start >= minutesOfDay(new Date());
  }
  function saveRequestMove(row: MyRequestRow, move: Parameters<typeof moveRequest.mutate>[0]["move"]) {
    moveRequest.mutate({ requestId: row.id, move }, {
      onSuccess: (result) => {
        if (result?.unchanged) return;
        const carName = (id: string | null | undefined) => (carsQuery.data ?? []).find((car) => car.id === id)?.name ?? "";
        if (!toastSubmitOutcome(result, { carName, preferredCarId: row.preferredCarId, tripType: row.tripType })) toast.success(t("request.submitSaved"));
      },
    });
  }
  function dropRequest(row: MyRequestRow, dayKey: string, start: number, duration: number) {
    if (row.departAt) saveRequestMove(row, { day: dayKey, departMinutes: start, returnMinutes: row.returnAt ? start + duration : null });
    else saveRequestMove(row, { day: dayKey, departMinutes: null, returnMinutes: start });
  }

  function selectWeek(next: string) {
    const params = new URLSearchParams(searchParams);
    params.set("week", next);
    setSearchParams(params, { replace: true });
  }

  function startRequest(dayKey: string, start: number, end: number) {
    const time = formatMinutes(Math.min(start, MAX_MINUTES));
    navigate(paths.requests.new({ week: weekStart, day: dayKey, time, end: end > start ? formatMinutes(Math.min(end, MAX_MINUTES)) : undefined }), requestLinkProps);
  }

  if (ridesQuery.isError) return <ErrorState onRetry={() => void ridesQuery.refetch()} />;

  return (
    <div className="space-y-3" data-testid="my-week-view" data-week-start={weekStart}>
      <div className="flex items-center justify-between gap-2">
        <MyWeekSwitcher weeks={weeks} activeWeekStart={weekStart} onSelect={selectWeek} onArchive={archive ? undefined : () => navigate(paths.myArchive())} />
        {onViewChange && !archive ? (
          <div className="flex items-center gap-2">
            {calendar.available ? (
              <Button type="button" variant="outline" size="icon" aria-label={he.calendar.openButton} onClick={() => setCalendarOpen(true)} data-testid="my-calendar-button">
                <CalendarDays className="size-4" />
              </Button>
            ) : null}
            <MyWeekDisplayMenu view="week" onViewChange={onViewChange} zoom={tableZoom} onZoomChange={setTableZoom} showKidsRides={showKidsRides} onShowKidsRidesChange={onShowKidsRidesChange} />
          </div>
        ) : null}
      </div>
      {isPast ? null : <RequestDeadlineNote week={week} />}
      <p className="text-xs text-muted-foreground" data-testid="my-week-hint">{isPast ? he.myWeek.hintReadOnly : acceptsRequests ? he.myWeek.hint : null}</p>
      {calendar.needsReconnect && !archive ? (
        <Button type="button" variant="outline" size="sm" onClick={() => void calendar.connect()} disabled={calendar.connecting} data-testid="calendar-reconnect">
          <CalendarDays className="me-2 size-4" aria-hidden="true" />{he.calendar.reconnect}
        </Button>
      ) : null}
      <div data-testid="my-week-grid">
        <WeekGrid
          cars={dayColumns}
          rides={entries.map((entry) => entry.block)}
          dayStartMinutes={visibleStartMinutes(entries, boardStartMinutes)}
          readOnly={isPast}
          draggable={!isPast && !rideMoves.saving && !moveRequest.isPending}
          canDragRide={(block) => canDrag(block.id)}
          canResizeRide={(block) => canResize(block.id)}
          isDropTargetValid={(blockId, dayKey, start, end) => {
            if (requestOf(blockId)) return requestTargetValid(dayKey, start, end);
            const ride = rideOf(blockId);
            const carId = ride ? sameDayCar(ride, dayKey) : null;
            return !!ride?.id && !!carId && rideMoves.isValidTarget(ride.id, carId, start, end);
          }}
          onRideDrop={(blockId, dayKey, start) => {
            const block = entries.find((entry) => entry.block.id === blockId)?.block;
            const row = requestOf(blockId);
            if (row && block) {
              if (requestTargetValid(dayKey, start, start + (block.endMinutes - block.startMinutes))) dropRequest(row, dayKey, start, block.endMinutes - block.startMinutes);
              return;
            }
            const ride = rideOf(blockId);
            const carId = ride ? sameDayCar(ride, dayKey) : null;
            if (ride?.id && carId) rideMoves.moveRide(ride.id, carId, start);
          }}
          onRideResize={(blockId, edge, minutes) => {
            const block = entries.find((entry) => entry.block.id === blockId)?.block;
            const row = requestOf(blockId);
            if (row && block && row.departAt) {
              saveRequestMove(row, { day: dateKey(row.departAt), departMinutes: edge === "start" ? minutes : null, returnMinutes: edge === "end" ? minutes : null });
              return;
            }
            const ride = rideOf(blockId);
            if (!ride?.id || !ride.car_id || !block) return;
            rideMoves.moveRide(ride.id, ride.car_id, edge === "start" ? minutes : block.startMinutes, edge === "end" ? minutes : block.endMinutes);
          }}
          markMyColumns={false}
          nowQuarterMinutes={dayColumns.some((column) => column.today) ? nowQuarter : null}
          zoom={tableZoom}
          onZoomChange={setTableZoom}
          onRideClick={(id) => { const target = targetById.get(id); if (target) onTarget(target); }}
          onSlotRange={acceptsRequests ? startRequest : undefined}
          rangeResetKey={weekStart}
          ambientBlocks={ambientBlocks}
          itemVisibility={calendarPrefs.itemVisibility}
          renderCarName={(column) => <span>{column.name}</span>}
        />
      </div>
      <ConfirmDialog {...rideMoves.collisionDialog} />
      {calendar.available ? <CalendarDialog open={calendarOpen} onOpenChange={setCalendarOpen} /> : null}
    </div>
  );
}
