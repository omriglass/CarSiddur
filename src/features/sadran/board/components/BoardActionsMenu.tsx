import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { BarChart3, Clock, Download, History, ListChecks, MoreVertical, PlayCircle, RefreshCw, Send, XCircle } from "lucide-react";

import { paths } from "@/app/routes";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { RequestDeviationsDialog } from "../../deviations/RequestDeviationsDialog";
import { useWeekExcelExport } from "../../export/useWeekExcelExport";
import { CancelPublicationAction } from "../../publish/components/BoardPublicationActions";
import { he, tv } from "@/i18n/he";

import { AutoFillDialog } from "./AutoFillDialog";
import { FullResolveAction } from "./FullResolveAction";
import { heldUpdateCount } from "../heldUpdates";
import { SendAllDialog, type PendingDraft } from "./SendAllDialog";
import { SetWeekCloseAction } from "./SetWeekCloseAction";

import type { ActivePolicy, HeldNotice } from "../../api";

interface BoardActionsMenuProps {
  departmentId: string;
  weekStart: string;
  homeDestinationId: string | null;
  policy: ActivePolicy | null;
  onPolicyUsed: (policyVersionId: string) => void;
  onAutoSolveRemaining: (day: string | null) => void;
  /** Per-day autofill picker (REQ §13.109 b). */
  days: string[];
  selectedDay: string;
  openCount: (day: string | null) => number;
  autoSolving: boolean;
  /** REQ §13.138 (d): the week's unsent Sadran drafts — "שלח את כל ההצעות" and the counter on the ⋮ button. */
  drafts: readonly PendingDraft[];
  /** REQ §13.138 (c): held board notices, sent with the drafts. */
  held: readonly HeldNotice[];
}

/**
 * Board "actions" kebab menu (UX_FLOWS.md §4.2, owner spec 2026-09-10),
 * rendered at every width: export, request deviations, auto-solve
 * remaining, "שלח את כל ההצעות" (REQ §13.138 d), full re-solve, cancel publication, and links to the change log
 * / proposals list. The primary publish button stays outside this menu,
 * always visible (`PublishButton`). Items that don't apply today (e.g.
 * cancel publication before anything is published) are hidden, same as the
 * old inline row.
 */
export function BoardActionsMenu({
  departmentId, weekStart, homeDestinationId, policy, onPolicyUsed, onAutoSolveRemaining, autoSolving, days, selectedDay, openCount, drafts, held,
}: BoardActionsMenuProps) {
  const pending = drafts.length + heldUpdateCount(held);
  const navigate = useNavigate();
  const [deviationsOpen, setDeviationsOpen] = useState(false);
  const [autoFillOpen, setAutoFillOpen] = useState(false);
  const [sendAllOpen, setSendAllOpen] = useState(false);
  // Controlled so opening a dialog that lives outside the menu also closes the menu (a menu left
  // open keeps the rest of the board aria-hidden after the dialog closes).
  const [menuOpen, setMenuOpen] = useState(false);
  const { download: downloadExcel, loading: exporting } = useWeekExcelExport(departmentId, weekStart);

  return <>
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="icon" aria-label={he.sadranBoard.actionsMenu} data-testid="board-actions-menu-trigger" className="relative">
          <MoreVertical className="size-4" />
          {pending ? (
            <span className="absolute -end-1.5 -top-1.5 min-w-4 rounded-full bg-primary px-1 text-[10px] leading-4 text-primary-foreground" data-testid="board-pending-count" title={tv("sendAll.menuCount", { count: String(pending) })}>
              {pending}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {/* No `preventDefault()` here: these two just kick off an async action, so the menu
            closes normally on selection (unlike the items below, which open a nested
            Dialog/Sheet and must keep the menu's own close/focus-return from racing it). */}
        <DropdownMenuItem disabled={exporting} onSelect={() => void downloadExcel()}>
          <Download className="me-2 size-4" aria-hidden="true" />
          {exporting ? he.excelExport.loading : he.excelExport.button}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setMenuOpen(false); setSendAllOpen(true); }} data-testid="board-send-all">
          <Send className="me-2 size-4" aria-hidden="true" />
          {he.sendAll.menuItem}
          {pending ? <span className="ms-auto text-xs text-muted-foreground">{tv("sendAll.menuCount", { count: String(pending) })}</span> : null}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={autoSolving} onSelect={(e) => { e.preventDefault(); setMenuOpen(false); setAutoFillOpen(true); }}>
          <PlayCircle className="me-2 size-4" aria-hidden="true" />
          {autoSolving ? he.sadranDashboard.solving : he.action.autoSolveRemaining}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setMenuOpen(false); setDeviationsOpen(true); }}>
          <ListChecks className="me-2 size-4" aria-hidden="true" />
          {he.deviations.title}
        </DropdownMenuItem>
        <SetWeekCloseAction
          departmentId={departmentId}
          weekStart={weekStart}
          renderTrigger={({ onClick }) => (
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); onClick(); }}>
              <Clock className="me-2 size-4" aria-hidden="true" />
              {he.weekClose.menuItem}
            </DropdownMenuItem>
          )}
        />
        <FullResolveAction
          departmentId={departmentId}
          weekStart={weekStart}
          homeDestinationId={homeDestinationId}
          policy={policy}
          onPolicyUsed={onPolicyUsed}
          disabled={autoSolving}
          renderTrigger={({ onClick, disabled, loading }) => (
            <DropdownMenuItem disabled={disabled} onSelect={(e) => { e.preventDefault(); onClick(); }}>
              <RefreshCw className="me-2 size-4" aria-hidden="true" />
              {loading ? he.sadranDashboard.fullResolveLoading : he.sadranDashboard.fullResolveButton}
            </DropdownMenuItem>
          )}
        />
        <CancelPublicationAction
          departmentId={departmentId}
          weekStart={weekStart}
          renderTrigger={({ onClick, label }) => (
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); onClick(); }}>
              <XCircle className="me-2 size-4" aria-hidden="true" />
              {label}
            </DropdownMenuItem>
          )}
        />
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate(paths.sadran.log(departmentId, weekStart))}>
          <History className="me-2 size-4" aria-hidden="true" />
          {he.screen.log.title}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate(paths.sadran.proposals(departmentId, weekStart))}>
          <ListChecks className="me-2 size-4" aria-hidden="true" />
          {he.screen.proposals.title}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate(paths.stats(departmentId))} data-testid="board-actions-stats">
          <BarChart3 className="me-2 size-4" aria-hidden="true" />
          {he.stats.title}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <AutoFillDialog
      open={autoFillOpen}
      onOpenChange={setAutoFillOpen}
      days={days}
      defaultDay={selectedDay}
      openCount={openCount}
      loading={autoSolving}
      onConfirm={(day) => { onAutoSolveRemaining(day); setAutoFillOpen(false); }}
    />
    <SendAllDialog open={sendAllOpen} onOpenChange={setSendAllOpen} departmentId={departmentId} weekStart={weekStart} drafts={drafts} held={held} />
    <RequestDeviationsDialog departmentId={departmentId} weekStart={weekStart} open={deviationsOpen} onOpenChange={setDeviationsOpen} />
  </>;
}
