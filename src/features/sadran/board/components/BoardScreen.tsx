import { useMaintenanceGridEditing } from "@/features/fleet/useMaintenanceGridEditing";
import { paths } from "@/app/routes";
import { formatInTimeZone } from "date-fns-tz";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { formatWeekRangeLabel } from "@/components/dateFieldDates";
import { CarSwapDialog } from "@/components/CarSwapDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { formatMinutes } from "@/components/timeField15Format";
import { requestStart, requestWindow, requestWithinFlex } from "../phantomLanes";
import {
  carFreeForSpan,
  isDropTargetValid,
  isUnmetDropValid,
  mergeCandidateForRide,
  minutesIso,
  passengersOf,
  seatsFit,
  unmetPreviewWindow,
} from "../dropValidity";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { hideIdleTemporaryCars } from "@/components/weekGridCars";
import { UNMET_DROP_ZONE_ATTR, WeekGrid } from "@/components/WeekGrid";
import { WeekStrip } from "@/components/WeekStrip";
import { WaitlistGroupCard } from "@/features/waitlist/components/WaitlistGroupCard";
import { WaitlistGroupSheet } from "@/features/waitlist/components/WaitlistGroupSheet";
import { CalendarDays, Redo2, Undo2 } from "lucide-react";
import { RideTypeLegend } from "@/components/RideTypeLegend";
import { BoardGridSkeleton } from "@/components/skeletons/BoardGridSkeleton";
import { PublishButton } from "../../publish/components/BoardPublicationActions";
import { he, tv } from "@/i18n/he";
import { askSmallTrunk } from "@/lib/smallTrunk";
import { formatDayDate } from "@/lib/dayLabels";
import { TZ, dateKey, formatTime } from "@/lib/time";
import { ridePublicDetails } from "@/lib/ridePublicDetails";
import { ridePassengerSummary } from "@/lib/ridePassengerSummary";
import { rideCoordinatorNotes } from "@/lib/rideCoordinatorNotes";

import { resolveRideRealDestination } from "../rideLabel";
import { duplicateChildRuns, groupDuplicateRuns } from "../duplicateChildRuns";
import { connectedMateOf, unmetItemId } from "../unmetLegs";
import { applyServerMergeTimes, mergeInvalidReason, mergeLegOptions, mergePayloadLeg, mergePayloadLegs, mergeVerdict, previewMerge, type MergeLeg, type MergeVerdict } from "../mergeProposal";
import { requestRouteLine } from "../requestRoute";
import { parseTimeToMinutes } from "@/features/solverBridge/buildSolverInput";
import { representativeRideTypeCode, servedOf, servedToEditRideLegs, withChildNames } from "../../solverRun";
import { useMergePreview, useMergePreviews, type MergePreviewSpec } from "../../hooks";
import { useBoardData } from "../hooks/useBoardData";
import { useBoardDnd } from "../hooks/useBoardDnd";
import { useBoardDisplayPrefs } from "../useBoardDisplayPrefs";
import { BoardActionsMenu } from "./BoardActionsMenu";
import { BoardDisplayMenu } from "./BoardDisplayMenu";
import { BoardListMode } from "./BoardListMode";
import { BoardTitleSwitcher } from "./BoardTitleSwitcher";
import { BoardWeekSwitcher } from "./BoardWeekSwitcher";
import { DraftChoiceDialog } from "./DraftChoiceDialog";
import type { FewerDaysSupport } from "./FewerDaysAction";
import type { ComposerPrefill } from "../draftInput";
import { MergePrefillDialog } from "./MergePrefillDialog";
import { ProposalActionSheet } from "./ProposalActionSheet";
import { PolicyChip } from "./PolicyChip";
import { ReservationDialog } from "./ReservationDialog";
import { RideSheet } from "./RideSheet";
import { UnmetList } from "./UnmetList";

interface BoardScreenProps {
  departmentId: string;
  weekStart: string;
}

/** `/sadran/:dept/:week/board` — the board (UX_FLOWS.md §4.2). */
export function BoardScreen({ departmentId, weekStart }: BoardScreenProps) {
  const navigate = useNavigate();

  const boardRef = useRef<HTMLDivElement>(null);
  const [conflictJump, setConflictJump] = useState<{ rideId: string; sequence: number } | null>(null);

  // Board queries + the pure derivation of the week-grid data (cars/rides/
  // blocks/unmet list/policy preview) — `useBoardData` (docs/TODO.md "Code
  // review 2026-09-24" R9). `focusedConflict`/`focusedConflictIndex` are
  // computed there from `conflictJump.rideId` since almost every other value
  // is keyed off the same day/board data bundle.
  const board = useBoardData(departmentId, weekStart, conflictJump?.rideId);
  // Interactive/drag-drop state + every handler that mutates rides/proposals
  // from the board — `useBoardDnd`.
  const dnd = useBoardDnd(departmentId, weekStart, board);
  // REQ §13.114: maintenance bands are drawn (and, for Sadranim/admins, draggable) from the full period rows.
  const maintenanceEditing = useMaintenanceGridEditing({ departmentId, blocks: board.maintenanceQuery.data ?? [], cars: board.weekGridCars, day: board.selectedDay, staff: true });
  // Destructured locally (not read off `dnd.` at the point of use) purely so
  // TypeScript's null-narrowing survives into the nested closures below
  // (`onSave`'s `.then()`, etc.) exactly as it did when these were plain
  // local `const`s in this component's own body.
  const { selectedRide, selectedPlanningChange, selectedRideDriverName, selectedUnmet, selectedWaitlistGroup } = dnd;

  // Mobile title switcher subtitle (UX_FLOWS.md §4.2): the department name only
  // shows there when the Sadran actually manages more than one.
  const managesMultipleDepartments = board.managesMultipleDepartments;

  // Vertical-board redesign (UX_FLOWS.md §20 "owner feedback: visible range
  // 06:00–24:00 by default; "הצג שעות מוקדמות" expands down to 00:00. Per-device
  // display preferences (list/table, zoom, early hours, legend) now live only
  // in the "eye" `BoardDisplayMenu`, at every width (owner correction,
  // 2026-09-10) — the standalone toggle button and `TableViewControls` row
  // are gone.
  const { tableView, setTableView, tableZoom, setTableZoom, showEarlyHours, setShowEarlyHours, showLegend, setShowLegend } = useBoardDisplayPrefs();
  const boardStartMinutes = board.departmentSettingsQuery.data?.board_start_time
    ? parseTimeToMinutes(board.departmentSettingsQuery.data.board_start_time) : 6 * 60;
  const dayStartMinutes = showEarlyHours ? 0 : boardStartMinutes;
  const dayEndMinutes = 24 * 60;

  function jumpToNextConflict() {
    const next = board.conflicts[(board.focusedConflictIndex + 1) % board.conflicts.length];
    if (!next) return;
    board.setSelectedDay(dateKey(next.starts_at));
    const minutes = Number(formatInTimeZone(next.starts_at, TZ, "H")) * 60 + Number(formatInTimeZone(next.starts_at, TZ, "m"));
    if (minutes < dayStartMinutes) setShowEarlyHours(true);
    setConflictJump({ rideId: next.id, sequence: (conflictJump?.sequence ?? 0) + 1 });
  }

  useEffect(() => {
    if (!conflictJump) return;
    // The chosen day and phone's car list have rendered before finding the target.
    const target = [...(boardRef.current?.querySelectorAll<HTMLElement>("[data-ride-id]") ?? [])]
      .find((element) => element.dataset.rideId === conflictJump.rideId && element.getClientRects().length > 0);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ behavior: "smooth", block: "start", inline: "center" });
  }, [conflictJump]);

  // REQ §13.94 (G10): the merge popup's base ride, added request and merged-ride preview.
  const mergeRequest = board.boardRequests.find((request) => request.id === dnd.mergePrefill?.requestId);
  const mergeLegs = mergePayloadLegs(dnd.mergePrefill?.payload);
  // REQ §13.102 (d): a split merge carries two rides (out on A, return on B), previewed each with its own leg.
  const mergeSplit = mergeLegs.length === 2 && mergeLegs[0]!.ride_id !== mergeLegs[1]!.ride_id;
  const mergeHost = board.rides.find((ride) => ride.id === (mergeLegs[0]?.ride_id ?? dnd.mergePrefill?.rideId));
  const mergeLeg = mergeRequest ? mergePayloadLeg(dnd.mergePrefill?.payload, mergeRequest) : "out";
  const splitMate = mergeSplit ? board.rides.find((ride) => ride.id === mergeLegs[1]!.ride_id) : undefined;
  // REQ §13.101 (k): a "both ways" merge into one leg of a connected הקפצה pair joins one leg per
  // ride on the server, so the popup previews both rides - each with its own leg.
  const mergePair = splitMate && mergeHost
    ? { mate: splitMate, rideLeg: mergeLegs[0]!.leg as "out" | "return", mateLeg: mergeLegs[1]!.leg as "out" | "return" }
    : mergeHost && mergeLeg === "both" ? connectedMateOf(board.rides, mergeHost) : null;
  // R5B5: the window and the guest's own times come from the server's `merge_preview` (the route picture and drag validity stay the TS twin's).
  const popupOpen = !!dnd.mergePrefill;
  const serverMergeHost = useMergePreview(mergeHost?.id, mergeRequest?.id, mergePair ? mergePair.rideLeg : mergeLeg, popupOpen);
  const serverMergeMate = useMergePreview(mergePair?.mate.id, mergeRequest?.id, mergePair?.mateLeg ?? "out", popupOpen && !!mergePair);
  const mergePreview = mergeHost && mergeRequest
    ? applyServerMergeTimes(previewMerge(mergeHost, mergeRequest, mergePair ? mergePair.rideLeg : mergeLeg, board.routeCtx), serverMergeHost.data, mergeRequest) : null;
  const mergePairPreview = mergePair && mergeRequest
    ? applyServerMergeTimes(previewMerge(mergePair.mate, mergeRequest, mergePair.mateLeg, board.routeCtx), serverMergeMate.data, mergeRequest) : null;
  // REQ item 108 (M1): which legs may be merged, and whether the popup may send/draft, is the SERVER's verdict
  // (`merge_preview` `ok`/`code` - the same check the real write runs). The TS twin only fills in when the preview
  // request itself failed; while it is loading nothing is offered yet.
  const verdictLegs: MergeLeg[] = mergeHost && mergeRequest && !mergeSplit
    ? [...new Set<MergeLeg>([...mergeLegOptions(mergeRequest, dnd.mergePrefill?.anchorLeg).choices, mergeLeg])] : [];
  const connectedMate = mergeHost && !mergeSplit ? connectedMateOf(board.rides, mergeHost) : null;
  const specsForLeg = (leg: MergeLeg): MergePreviewSpec[] => {
    if (!mergeHost || !mergeRequest) return [];
    if (leg === "both" && connectedMate) {
      return [{ rideId: mergeHost.id, requestId: mergeRequest.id, leg: connectedMate.rideLeg }, { rideId: connectedMate.mate.id, requestId: mergeRequest.id, leg: connectedMate.mateLeg }];
    }
    return [{ rideId: mergeHost.id, requestId: mergeRequest.id, leg }];
  };
  const verdictGroups: { leg: MergeLeg | "split"; specs: MergePreviewSpec[] }[] = mergeSplit && mergeHost && mergeRequest && mergePair
    ? [{ leg: "split", specs: [{ rideId: mergeHost.id, requestId: mergeRequest.id, leg: mergePair.rideLeg }, { rideId: mergePair.mate.id, requestId: mergeRequest.id, leg: mergePair.mateLeg }] }]
    : verdictLegs.map((leg) => ({ leg, specs: specsForLeg(leg) }));
  const verdictQueries = useMergePreviews(verdictGroups.flatMap((group) => group.specs), popupOpen);
  const legVerdicts: Partial<Record<MergeLeg, MergeVerdict>> = {};
  let splitVerdict: MergeVerdict | undefined;
  let queryIndex = 0;
  for (const group of verdictGroups) {
    const states = verdictQueries.slice(queryIndex, queryIndex + group.specs.length);
    queryIndex += group.specs.length;
    if (!mergeHost || !mergeRequest) continue;
    const twinInvalid = group.leg === "split"
      ? ((mergePreview && !mergePreview.valid ? mergePreview.invalid : null) ?? (mergePairPreview && !mergePairPreview.valid ? mergePairPreview.invalid : null))
      : mergeInvalidReason(mergeHost, mergeRequest, group.leg, board.routeCtx);
    const verdict = mergeVerdict(states, twinInvalid);
    if (group.leg === "split") splitVerdict = verdict; else legVerdicts[group.leg] = verdict;
  }
  const mergeVerdictNow: MergeVerdict | undefined = mergeSplit ? splitVerdict : legVerdicts[mergeLeg];
  // REQ §13.111 (a): a merge whose only problem is a missing large trunk is offered; sending or drafting it asks
  // "לשבץ בכל זאת?" first and carries `allow_small_trunk` in the proposal payload.
  async function withMergeWaiver(next: (prefill: ComposerPrefill) => void | Promise<void>) {
    const prefill = dnd.mergePrefill;
    if (!prefill) return;
    if (mergeVerdictNow?.status === "ok" && mergeVerdictNow.waivable) {
      const accepted = await askSmallTrunk({
        requestIds: mergeRequest ? [mergeRequest.id] : [],
        names: [mergeRequest?.requester_full_name ?? ""],
        carId: mergeHost?.car_id ?? null,
        carName: (board.carsQuery.data ?? []).find((car) => car.id === mergeHost?.car_id)?.name ?? null,
      });
      if (!accepted) return;
      await next({ ...prefill, payload: { ...prefill.payload, allow_small_trunk: true } });
      return;
    }
    await next(prefill);
  }
  const mergeHostDriverEntry = mergeHost ? (servedOf(mergeHost).find((entry) => entry.role === "driver") ?? servedOf(mergeHost)[0]) : undefined;
  const mergeHostRequest = mergeHostDriverEntry ? board.boardRequests.find((request) => request.id === mergeHostDriverEntry.request_id) : undefined;

  if (board.requestsQuery.isError || board.ridesQuery.isError) {
    return <ErrorState onRetry={() => board.ridesQuery.refetch()} />;
  }

  // Papercut fix (usability sweep): the board used to render immediately
  // with empty arrays while its own data was still in flight — an empty
  // grid and "לא שובצו (0)" for a moment on every load, indistinguishable
  // from an actually-empty week (the same misleading "nothing happened"
  // impression as bug #4). `route-level useSadranRouteParams` loading state
  // only covers the authorization check, not this screen's own queries.
  if (board.requestsQuery.isLoading || board.ridesQuery.isLoading || board.carsQuery.isLoading) {
    return (
      <div className="mx-auto w-full max-w-none space-y-3 p-4 pb-24">
        <PageHeader title={he.screen.board.title} subtitle={formatWeekRangeLabel(weekStart)} />
        <BoardGridSkeleton />
      </div>
    );
  }

  const conflictCount = board.conflicts.length;
  const fewerDays: FewerDaysSupport = {
    cars: (board.carsQuery.data ?? []).filter((car) => car.type !== "temporary" && car.status === "active").map((car) => ({ id: car.id, name: car.name })),
    isCarFree: (carId, startsAt, endsAt, hasLuggage, originId) => carFreeForSpan(board.dropCtx, carId, startsAt, endsAt, hasLuggage, originId ?? board.dropCtx.homeDestinationId),
    onPropose: dnd.goToComposer,
    requestIds: new Set(board.boardRequests.map((request) => request.id)),
  };
  const duplicateRuns = duplicateChildRuns(board.boardRequests).filter((run) => dateKey(run.startsAt) === board.selectedDay);
  const unmetPreview = dnd.unmetDragHover ? unmetPreviewWindow(board.dropCtx, dnd.unmetDragHover.item, dnd.unmetDragHover.carId, dnd.unmetDragHover.minutes, dnd.unmetDragHover.hostRideId) : null;

  const draftRideIds = new Set([
    ...board.pendingMerges.filter((merge) => merge.isDraft).map((merge) => `merge:${merge.proposal.id}`),
    ...board.draftPlacements.filter((placement) => placement.type !== "merge").map((placement) => `draft:${placement.proposalId}`),
  ]);
  const selectedProposalRequest = board.requestsQuery.data?.find((request) => request.id === dnd.selectedProposal?.request_id);
  // R5U1: the sheet states old -> new times and car (the car the request rides now vs the proposal's / host's car).
  const proposalChanges = (() => {
    const proposal = dnd.selectedProposal;
    if (!proposal || !selectedProposalRequest) return undefined;
    const carName = (carId: string | null | undefined) => (carId ? ((board.carsQuery.data ?? []).find((car) => car.id === carId)?.name ?? null) : null);
    const servingRide = board.rides.find((ride) => ride.status !== "cancelled" && servedOf(ride).some((entry) => entry.request_id === selectedProposalRequest.id));
    const payload = proposal.payload && typeof proposal.payload === "object" && !Array.isArray(proposal.payload) ? (proposal.payload as Record<string, unknown>) : {};
    const newCarId = proposal.type === "merge" ? board.rides.find((ride) => ride.id === proposal.ride_id)?.car_id : (typeof payload.car_id === "string" ? payload.car_id : null);
    return { request: selectedProposalRequest, oldCarName: carName(servingRide?.car_id), newCarName: carName(newCarId) };
  })();

  // REQ §13.94 (G10): live preview while a guest chip is dragged over a car (translucent, snapped, like a ride drag).
  const guestTarget = dnd.guestHover?.target;
  const guestRequest = board.boardRequests.find((request) => request.id === dnd.guestHover?.guest.requestId);
  const guestWindow = guestRequest ? requestWindow(guestRequest) : null;
  const guestMinutes = guestWindow ? Math.max(15, Math.round((Date.parse(guestWindow.endsAt) - Date.parse(guestWindow.startsAt)) / 60_000)) : 60;
  const guestPreview = guestTarget?.kind === "car" && dnd.guestHover
    ? { carId: guestTarget.carId, startMinutes: guestTarget.minutes, endMinutes: guestTarget.minutes + guestMinutes, label: dnd.guestHover.guest.name, valid: true }
    : null;

  const currentPolicyForActions = (board.policyOptionsQuery.data ?? []).find((policy) => policy.policyVersionId === board.effectivePolicyVersionId)
    ?? (board.activePolicyQuery.data?.policyVersionId === board.effectivePolicyVersionId ? board.activePolicyQuery.data ?? null : null);

  return (
    <div ref={boardRef} className="mx-auto w-full max-w-none space-y-3 p-4 pb-24">
      {/* Board header (UX_FLOWS.md §4.2, owner spec 2026-09-10): the title is the
          department/week switcher below `lg` (tap to switch) and the plain
          `PageHeader` + inline `BoardWeekSwitcher` selects from `lg` up; the
          policy chip, undo/redo icons, display ("eye") menu and actions
          (kebab) menu are identical at every width. */}
      <div className="flex items-center gap-2">
        <div className="lg:hidden">
          {/* Kept in the accessibility tree only below `lg` — `PageHeader`'s own
              `<h1>` (hidden lg:block below) takes over at `lg+`, so there is
              always exactly one "לוח הסידור" heading, never two. */}
          <h1 className="sr-only">{he.screen.board.title}</h1>
          <BoardTitleSwitcher
            departmentId={departmentId}
            weekStart={weekStart}
            departmentName={managesMultipleDepartments ? board.department?.name : undefined}
          />
        </div>
        <div className="hidden lg:block">
          <PageHeader title={he.screen.board.title} subtitle={formatWeekRangeLabel(weekStart)} />
        </div>
      </div>
      <div className="hidden lg:block">
        <BoardWeekSwitcher departmentId={departmentId} weekStart={weekStart} />
      </div>

      {/* Toolbar row (owner feedback 2026-09-10): publish on the start side; policy chip,
          undo/redo, display ("eye") and actions (kebab) menus on the end side — never on
          the title line. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PublishButton departmentId={departmentId} weekStart={weekStart} />
        {/* R10U11: the chip may wrap onto its own line; the four icon buttons stay together, so the "⋮" is never pushed past the screen edge. */}
        <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
          <PolicyChip
            policyOptions={board.policyOptionsQuery.data ?? []}
            activePolicy={board.activePolicyQuery.data ?? null}
            value={board.effectivePolicyVersionId}
            stale={board.policyIsStale}
            onSelect={board.selectPolicyVersion}
            scores={board.boardPolicyScores}
          />
          <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="outline" size="icon" aria-label={he.action.undo} disabled={!dnd.undoStack.canUndo} onClick={() => void dnd.handleUndo()}>
            <Undo2 className="size-4 rtl:rotate-180" />
          </Button>
          <Button type="button" variant="outline" size="icon" aria-label={he.sadranBoard.redo} disabled={!dnd.undoStack.canRedo} onClick={() => void dnd.handleRedo()}>
            <Redo2 className="size-4 rtl:rotate-180" />
          </Button>
          <BoardDisplayMenu
            table={tableView}
            onTableChange={setTableView}
            zoom={tableZoom}
            onZoomChange={setTableZoom}
            showEarlyHours={showEarlyHours}
            onShowEarlyHoursChange={setShowEarlyHours}
            showLegend={showLegend}
            onShowLegendChange={setShowLegend}
          />
          <BoardActionsMenu
            departmentId={departmentId}
            weekStart={weekStart}
            homeDestinationId={board.department?.home_destination_id ?? null}
            policy={currentPolicyForActions}
            onPolicyUsed={board.rememberUsedPolicy}
            onAutoSolveRemaining={board.handleAutoSolveRemaining}
            autoSolving={board.autoSolving}
            days={board.days}
            selectedDay={board.selectedDay}
            openCount={board.openRequestCount}
          />
          </div>
        </div>
      </div>

      {conflictCount > 0 ? (
        <button type="button" onClick={jumpToNextConflict} title={he.sadranBoard.nextConflict}
          className="w-full rounded-md border border-destructive/40 bg-destructive/5 p-2 text-start text-sm text-destructive hover:bg-destructive/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-destructive">
          {tv("sadranBoard.conflictBanner", { count: String(conflictCount) })}
          <span className="ms-2 text-xs">{he.sadranBoard.nextConflict}</span>
          {board.focusedConflict ? <span aria-live="polite" className="mt-1 block font-semibold">{tv("sadranBoard.conflictLocation", {
            index: String(board.focusedConflictIndex + 1), count: String(conflictCount),
            date: formatDayDate(board.focusedConflict.starts_at),
            time: `\u2066${formatTime(new Date(board.focusedConflict.starts_at))}–${formatTime(new Date(board.focusedConflict.ends_at))}\u2069`,
            car: board.carsQuery.data?.find((car) => car.id === board.focusedConflict!.car_id)?.name ?? "",
          })}</span> : null}
        </button>
      ) : null}

      {duplicateRuns.length > 0 ? (
        <div role="status" aria-label={he.duplicateChild.listLabel} data-testid="duplicate-child-warning"
          className="space-y-1 rounded-md border border-maintenance/50 bg-maintenance/10 p-2 text-sm">
          {groupDuplicateRuns(duplicateRuns).map((run) => (
            <p key={run.key}>
              <span className="font-semibold">{tv("duplicateChild.banner", { child: run.childNames.join(", ") })}</span>
              {" · "}
              {tv("duplicateChild.line", {
                a: run.requests[0]?.requester_full_name ?? "", b: run.requests[1]?.requester_full_name ?? "",
                dayTime: `${formatDayDate(run.startsAt)} ${formatTime(new Date(run.startsAt))}`,
              })}
            </p>
          ))}
          <p className="text-xs text-muted-foreground">{he.duplicateChild.hint}</p>
        </div>
      ) : null}

      <WeekStrip weekStart={weekStart} counts={board.dayCounts} selected={board.selectedDay} onSelect={board.setSelectedDay} />
      {maintenanceEditing.dialog}

      <div className={showLegend ? "" : "hidden lg:block"}>
        <RideTypeLegend types={(board.rideTypesQuery.data ?? []).map((rt) => ({ code: rt.code, nameHe: rt.name_he }))} />
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className={tableView ? "min-w-0" : "hidden min-w-0 lg:block"}>
          <WeekGrid
            zoom={tableZoom}
            onZoomChange={setTableZoom}
            cars={hideIdleTemporaryCars(board.weekGridCars, board.weekGridRides)}
            rides={board.weekGridRides}
            blocks={[...maintenanceEditing.gridBlocks, ...board.awayWeekGridBlocks]}
            onBlockChange={maintenanceEditing.onBlockChange}
            onBlockClick={maintenanceEditing.onBlockClick}
            dayStartMinutes={dayStartMinutes}
            dayEndMinutes={dayEndMinutes}
            readOnly={false}
            draggable
            canDragRide={(ride) => !ride.id.startsWith("merge:") && !ride.id.startsWith("draft:") && (!ride.id.startsWith("change:") || !!(board.rideChangesQuery.data ?? []).find((change) => change.is_planning && `change:${change.id}` === ride.id))}
            canResizeRide={(ride) => !ride.id.startsWith("request:") && !ride.id.startsWith("change:") && !ride.id.startsWith("merge:") && !ride.id.startsWith("draft:")}
            onSlotClick={(carId, minutes) => !carId.startsWith("phantom:") && dnd.setReservation({ carId, start: formatMinutes(minutes), end: formatMinutes(Math.min(1439, minutes + 60)), notes: "", memberIds: [], childIds: [], kind: "reservation", toPlaceId: "" })}
            onRideClick={dnd.handleRideClick}
            onRideDrop={(rideId, carId, minutes, droppedOnRideId) => void dnd.handleRideDrop(rideId, carId, minutes, droppedOnRideId)}
            onRideResize={dnd.handleRideResize}
            isDropTargetValid={(rideId, carId, startMinutes, endMinutes, hostRideId) => isDropTargetValid(board.dropCtx, rideId, carId, startMinutes, endMinutes, hostRideId)}
            resolveDropPreview={(ride, carId, startMinutes, endMinutes, hostRideId) => {
              const item = board.unmetItems.find((item) => unmetItemId(item) === ride.id);
              if (carId.startsWith("phantom:")) return { startMinutes, endMinutes };
              const window = item ? unmetPreviewWindow(board.dropCtx, item, carId, startMinutes, hostRideId)
                : mergeCandidateForRide(board.dropCtx, ride.id, carId, minutesIso(board.dropCtx, startMinutes), minutesIso(board.dropCtx, endMinutes), hostRideId)?.window;
              return window ? { startMinutes: (Date.parse(window.startsAt) - Date.parse(board.dayStartIso(board.selectedDay))) / 60_000,
                endMinutes: (Date.parse(window.endsAt) - Date.parse(board.dayStartIso(board.selectedDay))) / 60_000 } : { startMinutes, endMinutes };
            }}
            externalDropTarget={
              dnd.unmetDragHover
                ? {
                    carId: dnd.unmetDragHover.carId,
                    startMinutes: unmetPreview ? (Date.parse(unmetPreview.startsAt) - Date.parse(board.dayStartIso(board.selectedDay))) / 60_000 : dnd.unmetDragHover.minutes,
                    endMinutes: unmetPreview ? (Date.parse(unmetPreview.endsAt) - Date.parse(board.dayStartIso(board.selectedDay))) / 60_000 : dnd.unmetDragHover.minutes + 30,
                    label: `${dnd.unmetDragHover.item.request.requester_full_name ?? ""} · ${dnd.unmetDragHover.item.destinationName}`,
                    valid: isUnmetDropValid(board.dropCtx, dnd.unmetDragHover.item, dnd.unmetDragHover.carId, dnd.unmetDragHover.minutes, dnd.unmetDragHover.hostRideId),
                  }
                : guestPreview
            }
            onGuestHover={(guest, target) => dnd.setGuestHover({ guest, target })}
            onGuestDrop={(guest, target) => void dnd.handleGuestDrop(guest, target)}
            onRideDropOnUnmet={(rideId) => void dnd.handleUnassignRide(rideId)}
            discussionBlocks={board.weekGridDiscussionBlocks}
            onDiscussionClick={dnd.setSelectedGroupId}
            canSwapCars={board.boardCanSwapCars}
            onCarSwap={(carA, carB) => { dnd.setCarSwapPair({ carA, carB }); }}
          />
        </div>

        <div className={tableView ? "hidden" : "lg:hidden"}>
          {board.dayWaitlistGroups.length ? (
            <div className="mb-2 space-y-2">
              {board.dayWaitlistGroups.map((group) => (
                <WaitlistGroupCard key={group.id} group={group} onClick={() => dnd.setSelectedGroupId(group.id)} />
              ))}
            </div>
          ) : null}
          <BoardListMode
            key={conflictJump?.sequence ?? 0}
            shadowedRideIds={board.shadowedRideIds}
            draftRideIds={draftRideIds}
            pendingRides={[
              ...board.pendingMerges.filter((merge) => dateKey(merge.startsAt) === board.selectedDay).map((merge) => ({
                id: `merge:${merge.proposal.id}`, startsAt: merge.startsAt, endsAt: merge.endsAt,
                originName: merge.host.origin_name ?? "", destinationName: board.weekGridRides.find((ride) => ride.id === `merge:${merge.proposal.id}`)?.label ?? "",
                driverName: merge.host.driver_name, carName: (board.carsQuery.data ?? []).find((car) => car.id === merge.host.car_id)?.name ?? null,
              })),
              // REQ §13.94: shift/origin drafts as "result" cards, same as the grid's dashed blocks.
              ...board.draftPlacements.filter((placement) => placement.type !== "merge" && dateKey(placement.startsAt) === board.selectedDay).map((placement) => ({
                id: `draft:${placement.proposalId}`, startsAt: placement.startsAt, endsAt: placement.endsAt,
                originName: "", destinationName: board.weekGridRides.find((ride) => ride.id === `draft:${placement.proposalId}`)?.label ?? "",
                driverName: null, carName: (board.carsQuery.data ?? []).find((car) => car.id === placement.carId)?.name ?? null,
              })),
            ]}
            rides={[...board.activeDayRides, ...board.planningRows.filter((ride) => dateKey(ride.starts_at) === board.selectedDay)]
              .filter((r) => r.id && r.starts_at)
              .map((r) => ({
                id: r.id as string,
                startsAt: r.starts_at as string,
                endsAt: r.ends_at,
                originName: r.origin_name ?? "",
                // Same fix as the grid's `rideBlockLabel` (bug #3): a round
                // trip's own `destination_name` is always home ("נבו").
                description: [servedOf(r).length ? r.notes : null, ridePublicDetails(withChildNames(servedOf(r), board.requestsQuery.data ?? []), { includeCompanions: false })].filter(Boolean).join("\n"),
                passengerSummary: ridePassengerSummary(withChildNames(servedOf(r), board.requestsQuery.data ?? []), r.needs_driver ? null : r.driver_name),
                coordinatorNotes: rideCoordinatorNotes(servedOf(r), board.requestsQuery.data ?? []),
                label: board.weekGridRides.find((item) => item.id === r.id)?.label,
                destinationName: (
                  board.department?.home_destination_id && r.origin_id && r.destination_id
                    ? resolveRideRealDestination({
                        originId: r.origin_id,
                        destinationId: r.destination_id,
                        originName: r.origin_name ?? "",
                        destinationName: r.destination_name ?? "",
                        homeDestinationId: board.department.home_destination_id,
                        served: servedOf(r),
                      })
                    : (r.destination_name ?? "")),
                driverName: r.driver_name,
                needsDriver: !!r.needs_driver,
                conflict: board.conflictRideIds.has(r.id as string),
                highlighted: board.focusedConflict?.id === r.id,
                tightSchedule: board.tightRideIds.has(r.id as string),
                isChauffeur: !!r.is_chauffeur,
                carName: (board.carsQuery.data ?? []).find((c) => c.id === r.car_id)?.name ?? null,
                carType: (board.carsQuery.data ?? []).find((c) => c.id === r.car_id)?.type,
                rideTypeCode: representativeRideTypeCode(servedOf(r)),
              }))}
            onRideClick={dnd.handleRideClick}
            unmetItems={board.unmetItems}
            onUnmetAction={dnd.handleUnmetAction}
            onUnmetDecision={dnd.handleUnmetDecision}
            onOpenProposal={dnd.setSelectedProposalId}
            onOpenProposals={() => navigate(paths.sadran.proposals(departmentId, weekStart))}
            pendingProposalsCount={(board.proposalsQuery.data ?? []).filter((p) => p.status === "sent").length}
            homeDestinationId={board.department?.home_destination_id ?? undefined}
            tripTypeScope={{ departmentId, weekStart }}
            fewerDays={fewerDays}
          />

        </div>

        <div
          // On `lg` the table is part of the page, so this panel stays pinned (`sticky top-0`) while the page
          // scrolls, capped to the screen height with its own scroll when the list is longer (REQ §13.106).
          // overflow-auto` side-by-side (UX_FLOWS.md §20) — without this the panel grows with
          // the page, forcing a page-level scroll to reach lower unmet cards that also pushes
          // the grid itself off-screen.
          className={tableView ? "min-w-0" : "hidden min-w-0 lg:sticky lg:top-0 lg:block lg:max-h-[100dvh] lg:self-start lg:overflow-auto"}
          {...{ [UNMET_DROP_ZONE_ATTR]: "true" }}
        >
          <h2 className="mb-2 font-semibold">{tv("sadranBoard.unmetTitle", { count: String(board.unmetItems.length) })}</h2>
          {board.unmetItems.length === 0 ? (
            <EmptyState icon={CalendarDays} message={he.sadranBoard.noSuggestions} />
          ) : (
            <UnmetList
              items={board.unmetItems}
              onAction={dnd.handleUnmetAction}
              onDecision={dnd.handleUnmetDecision}
              onOpenProposal={dnd.setSelectedProposalId}
              homeDestinationId={board.department?.home_destination_id ?? undefined}
              tripTypeScope={{ departmentId, weekStart }}
              fewerDays={fewerDays}
              dayStartMinutes={dayStartMinutes}
              dayEndMinutes={dayEndMinutes}
              onDragHover={(item, carId, minutes, hostRideId) => dnd.setUnmetDragHover(carId && minutes != null ? { item, carId, minutes, hostRideId } : null)}
              onDragDrop={(item, carId, minutes, hostRideId) => void dnd.handlePlaceUnmetRequest(item, carId, minutes, hostRideId)}
              // The `<h2>` right above already renders this exact title — avoid duplicating it.
              showHeading={false}
            />
          )}
        </div>
      </div>

      <MergePrefillDialog
        prefill={dnd.mergePrefill}
        hostLabel={board.weekGridRides.find((ride) => ride.id === dnd.mergePrefill?.rideId)?.label ?? mergeHost?.driver_name}
        hostStartsAt={mergeHost?.starts_at}
        hostEndsAt={mergeHost?.ends_at}
        request={mergeRequest}
        hostRequest={mergeHostRequest}
        pair={mergePair ? {
          label: board.weekGridRides.find((ride) => ride.id === mergePair.mate.id)?.label ?? mergePair.mate.driver_name ?? "",
          startsAt: mergePair.mate.starts_at, endsAt: mergePair.mate.ends_at, preview: mergePairPreview,
        } : null}
        requestRoute={mergeRequest ? requestRouteLine({ originId: mergeRequest.origin_id, originName: mergeRequest.origin_id ? mergeRequest.origin_resolved_name : null, originText: mergeRequest.origin_text, destination: mergeRequest.destination_resolved_name ?? mergeRequest.destination_text ?? "", tripType: mergeRequest.trip_type }, board.department?.home_destination_id) : ""}
        leg={mergeLeg}
        onLegChange={dnd.setMergeLeg}
        anchorLeg={dnd.mergePrefill?.anchorLeg}
        legVerdicts={legVerdicts}
        verdict={mergeVerdictNow}
        split={mergeSplit}
        draftNote={dnd.mergePrefill?.draftNote}
        preview={mergePreview}
        onConfirm={() => { void withMergeWaiver((prefill) => { dnd.openComposer(prefill); dnd.setMergePrefill(null); }); }}
        onDraft={() => { void withMergeWaiver((prefill) => dnd.saveDraft(prefill)); }}
        busy={dnd.draftPending}
        onCancel={() => dnd.setMergePrefill(null)}
      />
      <DraftChoiceDialog
        choice={dnd.composeChoice}
        requesterName={board.requestsQuery.data?.find((request) => request.id === dnd.composeChoice?.requestId)?.requester_full_name}
        onCompose={dnd.composeFromChoice}
        onDraft={() => { if (dnd.composeChoice) void dnd.saveDraft(dnd.composeChoice); }}
        busy={dnd.draftPending}
        onCancel={() => dnd.setComposeChoice(null)}
      />
      <ProposalActionSheet
        proposal={dnd.selectedProposal}
        requesterName={selectedProposalRequest?.requester_full_name}
        dayIso={selectedProposalRequest ? requestStart(selectedProposalRequest) : null}
        changes={proposalChanges}
        busy={dnd.proposalActionPending}
        onOpenChange={(open) => !open && dnd.setSelectedProposalId(null)}
        onSend={dnd.sendDraft}
        onEdit={dnd.editDraft}
        onDiscard={(proposal) => void dnd.discardDraft(proposal)}
        onWithdraw={(proposal) => void dnd.withdrawSent(proposal)}
      />
      <Sheet open={!!selectedUnmet} onOpenChange={(open) => !open && dnd.setSelectedUnmetId(null)}>
        <SheetContent side="bottom"><SheetHeader><SheetTitle>{he.board.unmet}</SheetTitle></SheetHeader>
          {selectedUnmet ? <UnmetList items={[selectedUnmet]} onAction={dnd.handleUnmetAction} onDecision={dnd.handleUnmetDecision} onOpenProposal={dnd.setSelectedProposalId} homeDestinationId={board.department?.home_destination_id ?? undefined} tripTypeScope={{ departmentId, weekStart }} fewerDays={fewerDays} /> : null}
        </SheetContent>
      </Sheet>

      <WaitlistGroupSheet
        group={selectedWaitlistGroup}
        departmentId={departmentId}
        weekStart={weekStart}
        profileId={undefined}
        canManageWeek
        onOpenChange={(open) => !open && dnd.setSelectedGroupId(null)}
      />
      {dnd.carSwapPair ? (
        <CarSwapDialog
          open
          onOpenChange={(open) => !open && dnd.setCarSwapPair(null)}
          departmentId={departmentId}
          weekStart={weekStart}
          day={board.selectedDay}
          carA={{ id: dnd.carSwapPair.carA, name: board.weekGridCars.find((c) => c.id === dnd.carSwapPair!.carA)?.name ?? "" }}
          carB={{ id: dnd.carSwapPair.carB, name: board.weekGridCars.find((c) => c.id === dnd.carSwapPair!.carB)?.name ?? "" }}
        />
      ) : null}
      <ReservationDialog
        reservation={dnd.reservation}
        onChange={dnd.setReservation}
        onOpenChange={(open) => { if (!open) dnd.setReservation(null); }}
        selectedDay={board.selectedDay}
        cars={board.carsQuery.data ?? []}
        members={dnd.reservationMembersQuery.data ?? []}
        children={dnd.reservationChildrenQuery.data ?? []}
        places={(board.destinationsQuery.data ?? []).map((d) => ({ id: d.id, name: d.name }))}
        carLocationName={dnd.reservationFromName}
        carLocationId={dnd.reservationFromId}
        onSave={() => void dnd.saveReservation()}
        saving={dnd.editRideMutation.isPending || dnd.setRidePassengersMutation.isPending || dnd.markCarMoveMutation.isPending}
      />
      <ConfirmDialog
        open={!!dnd.seriesMoveConfirm}
        onOpenChange={(open) => { if (!open) dnd.setSeriesMoveConfirm(null); }}
        title={he.sadranBoard.seriesMoveTitle}
        description={
          dnd.seriesMoveConfirm
            ? tv("sadranBoard.seriesMoveBody", { index: String(dnd.seriesMoveConfirm.index), count: String(dnd.seriesMoveConfirm.count), car: dnd.seriesMoveConfirm.carName })
            : undefined
        }
        onConfirm={() => {
          const confirmed = dnd.seriesMoveConfirm;
          dnd.setSeriesMoveConfirm(null);
          if (confirmed) void confirmed.run();
        }}
      />
      <ConfirmDialog
        open={!!dnd.invalidDropConfirm}
        onOpenChange={(open) => { if (!open) dnd.setInvalidDropConfirm(null); }}
        title={he.sadranBoard.invalidDropTitle}
        description={he.sadranBoard.invalidDropBody}
        onConfirm={() => {
          const confirmed = dnd.invalidDropConfirm;
          dnd.setInvalidDropConfirm(null);
          if (confirmed) void confirmed.run();
        }}
      />
      <RideSheet
        pendingMerge={(() => {
          const pending = selectedRide?.id && !selectedPlanningChange ? board.pendingMerges.find((merge) => merge.host.id === selectedRide.id && !merge.isDraft) : undefined;
          return pending ? { guestName: pending.guest.requester_full_name ?? "", onOpen: () => { dnd.setSelectedRideId(null); dnd.setSelectedProposalId(pending.proposal.id); } } : null;
        })()}
        driverCandidates={(dnd.reservationMembersQuery.data ?? []).map((m) => ({ ...m, homePlaceId: m.homeOriginId }))}
        otherRides={board.rides}
        key={selectedPlanningChange?.id ?? selectedRide?.id ?? "no-ride"}
        ride={selectedRide && selectedPlanningChange ? { ...selectedRide, car_id: selectedPlanningChange.car_id, starts_at: selectedPlanningChange.starts_at, ends_at: selectedPlanningChange.ends_at } : selectedRide}
        isPlanning={!!selectedPlanningChange}
        coordinatorNotes={selectedRide ? rideCoordinatorNotes(servedOf(selectedRide), board.requestsQuery.data ?? []) : undefined}
        requests={board.requestsQuery.data ?? []}
        departmentId={departmentId}
        weekStart={weekStart}
        cars={board.carsQuery.data ?? []}
        driverName={selectedRideDriverName}
        homeDestinationId={board.department?.home_destination_id ?? null}
        destinations={(board.destinationsQuery.data ?? []).map((d) => ({ id: d.id, name: d.name, aliases: d.aliases, zone: d.zone }))}
        onSaveRoute={(values) => { if (selectedRide) void dnd.saveRideRoute(selectedRide, values); }}
        onRemoveAddedPerson={(requestId, name) => { if (selectedRide?.id) void dnd.removeAddedPerson(selectedRide.id, requestId, name); }}
        onOpenChange={(open) => !open && dnd.setSelectedRideId(null)}
        saving={dnd.editRideMutation.isPending || dnd.claimDriverMutation.isPending}
        tightSchedule={!!selectedRide?.id && board.tightRideIds.has(selectedRide.id)}
        onClaimDriver={() => {
          if (!selectedRide?.id || selectedRide.version == null) return;
          dnd.claimDriverMutation.mutate({ rideId: selectedRide.id, expectedVersion: selectedRide.version }, { onSuccess: () => toast.success(he.boardCoordination.driverClaimed) });
        }}
        onSave={(input) => {
          if (!selectedRide?.id || !selectedRide.origin_id || !selectedRide.destination_id) return;
          if (Date.parse(input.endsAt) <= Date.parse(input.startsAt)) { toast.error(he.sadranBoard.invalidWindow); return; }
          const hasCollision = board.rides.some((other) => other.id !== selectedRide.id && other.car_id === input.carId && other.starts_at && other.ends_at
            && Date.parse(other.starts_at) < Date.parse(input.endsAt) && Date.parse(input.startsAt) < Date.parse(other.ends_at));
          const outsideFlex = servedOf(selectedRide).map((entry) => (board.requestsQuery.data ?? []).find((req) => req.id === entry.request_id))
            .find((req) => req && !requestWithinFlex(req, input.startsAt, input.endsAt));
          if (outsideFlex && !(hasCollision && selectedRide.status !== "draft")) {
            dnd.goToComposer({ requestId: outsideFlex.id, rideId: selectedRide.id, type: "shift", payload: { car_id: input.carId, depart_at: input.startsAt, return_at: input.endsAt, origin_id: selectedRide.origin_id, destination_id: selectedRide.destination_id, ride_id: selectedRide.id } });
            return;
          }
          // Same conflict checks as the drag path (bug #2: "checked and
          // reported in Hebrew" applies to the no-drag car-select fallback
          // too, not only dragging) — without this, picking an already-
          // occupied car raised a raw, untranslated Postgres exclusion-
          // constraint error (`rides_no_overlap_per_car`) and, because nothing
          // downstream of this `mutateAsync` call caught the rejection, the
          // sheet was left stuck open with no clear feedback (reproduced
          // directly; `e2e/board.spec.ts`'s car-selector test caught it).
          if (input.carId !== selectedRide.car_id && !seatsFit(board.dropCtx, input.carId, passengersOf(selectedRide))) {
            toast.error(he.sadranBoard.seatMismatchToast);
            return;
          }
          void dnd.editRideMutation
            .mutateAsync({
              input: {
                id: selectedRide.id,
                department_id: departmentId,
                week_start: weekStart,
                car_id: input.carId,
                starts_at: input.startsAt,
                ends_at: input.endsAt,
                origin_id: selectedRide.origin_id,
                destination_id: selectedRide.destination_id,
                driver_id: selectedRide.driver_id,
                needs_driver: !!selectedRide.needs_driver,
                allow_conflict: true,
                notes: selectedRide.notes,
                // REQUIREMENTS §13.93: the day-end rule/overnight acknowledgement are retired —
                // `edit_ride` no longer needs this field (the DB column is deprecated, not
                // dropped; omitting it here is harmless for old data).
                // Manual save (including a plain car change via the sheet's
                // select, the no-drag fallback bug #2 asks for) auto-pins,
                // same reasoning as the drag path above.
                is_pinned: true,
                pin_reason: selectedRide.pin_reason ?? "SADRAN_MANUAL",
                served: servedToEditRideLegs(servedOf(selectedRide)),
              },
              expectedVersion: selectedPlanningChange?.expected_version ?? selectedRide.version ?? undefined,
              departmentId,
              weekStart,
            })
            .then(() => { if (hasCollision && selectedRide.status !== "draft") toast.success(he.boardCoordination.planningSaved); dnd.setSelectedRideId(null); })
            .catch(() => {
              // Toast already shown by the mutation's onError; keep the
              // sheet open (not closed) so the Sadran can adjust and retry,
              // and don't leave an unhandled rejection behind.
            });
        }}
        onTogglePin={(nextPinned, reason) => {
          if (!selectedRide?.id || !selectedRide.car_id || !selectedRide.origin_id || !selectedRide.destination_id) return;
          void dnd.editRideMutation.mutateAsync({
            input: {
              id: selectedRide.id,
              department_id: departmentId,
              week_start: weekStart,
              car_id: selectedRide.car_id,
              starts_at: selectedRide.starts_at as string,
              ends_at: selectedRide.ends_at as string,
              origin_id: selectedRide.origin_id,
              destination_id: selectedRide.destination_id,
              driver_id: selectedRide.driver_id,
                notes: selectedRide.notes ?? undefined,
              is_pinned: nextPinned,
              pin_reason: reason,
              served: servedToEditRideLegs(servedOf(selectedRide)),
            },
            expectedVersion: selectedRide.version ?? undefined,
            departmentId,
            weekStart,
          });
        }}
        onCancel={(reason) => {
          if (selectedPlanningChange) { dnd.cancelRideChangeMutation.mutate(selectedPlanningChange.id, { onSuccess: () => dnd.setSelectedRideId(null) }); return; }
          if (!selectedRide?.id) return;
          void dnd.cancelRideMutation
            .mutateAsync({ rideId: selectedRide.id, reason, expectedVersion: selectedRide.version ?? undefined, departmentId, weekStart })
            .then(() => dnd.setSelectedRideId(null))
            .catch(() => {
              // Toast already shown by the mutation's onError; same reasoning as `onSave` above.
            });
        }}
        onJoinLegs={(requestId) => {
          if (!selectedRide?.id) return;
          void dnd.handleJoinLegs(selectedRide.id, requestId).then(() => dnd.setSelectedRideId(null));
        }}
        onUnassign={() => {
          if (!selectedRide?.id) return;
          void dnd.handleUnassignRide(selectedRide.id).then(() => dnd.setSelectedRideId(null));
        }}
      />
    </div>
  );
}
