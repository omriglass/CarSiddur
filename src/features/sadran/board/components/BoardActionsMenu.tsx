import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { BarChart3, Download, History, ListChecks, MoreVertical, PlayCircle, RefreshCw, XCircle } from "lucide-react";

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
import { useWeekExcelExport } from "../../export/WeekExcelExportButton";
import { CancelPublicationAction } from "../../publish/components/BoardPublicationActions";
import { he } from "@/i18n/he";

import { FullResolveAction } from "./FullResolveAction";

import type { ActivePolicy } from "../../api";

interface BoardActionsMenuProps {
  departmentId: string;
  weekStart: string;
  homeDestinationId: string | null;
  policy: ActivePolicy | null;
  onPolicyUsed: (policyVersionId: string) => void;
  onAutoSolveRemaining: () => void;
  autoSolving: boolean;
}

/**
 * Board "actions" kebab menu (UX_FLOWS.md §4.2, owner spec 2026-09-10),
 * rendered at every width: export, request deviations, auto-solve
 * remaining, full re-solve, cancel publication, and links to the change log
 * / proposals list. The primary publish button stays outside this menu,
 * always visible (`PublishButton`). Items that don't apply today (e.g.
 * cancel publication before anything is published) are hidden, same as the
 * old inline row.
 */
export function BoardActionsMenu({
  departmentId, weekStart, homeDestinationId, policy, onPolicyUsed, onAutoSolveRemaining, autoSolving,
}: BoardActionsMenuProps) {
  const navigate = useNavigate();
  const [deviationsOpen, setDeviationsOpen] = useState(false);
  const { download: downloadExcel, loading: exporting } = useWeekExcelExport(departmentId, weekStart);

  return <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="icon" aria-label={he.sadranBoard.actionsMenu} data-testid="board-actions-menu-trigger">
          <MoreVertical className="size-4" />
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
        <DropdownMenuItem disabled={autoSolving} onSelect={onAutoSolveRemaining}>
          <PlayCircle className="me-2 size-4" aria-hidden="true" />
          {autoSolving ? he.sadranDashboard.solving : he.action.autoSolveRemaining}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setDeviationsOpen(true); }}>
          <ListChecks className="me-2 size-4" aria-hidden="true" />
          {he.deviations.title}
        </DropdownMenuItem>
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
          renderTrigger={({ onClick }) => (
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); onClick(); }}>
              <XCircle className="me-2 size-4" aria-hidden="true" />
              {he.publicationFlow.cancel}
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
    <RequestDeviationsDialog departmentId={departmentId} weekStart={weekStart} open={deviationsOpen} onOpenChange={setDeviationsOpen} />
  </>;
}
