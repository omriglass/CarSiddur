import { Eye, List, RotateCw, Table2, ZoomIn, ZoomOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLandscapeToggle } from "@/components/useLandscapeToggle";
import { he } from "@/i18n/he";

interface BoardDisplayMenuProps {
  table: boolean;
  onTableChange: (table: boolean) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  showEarlyHours: boolean;
  onShowEarlyHoursChange: (value: boolean) => void;
  showLegend: boolean;
  onShowLegendChange: (value: boolean) => void;
}

/**
 * Board "display" icon menu (UX_FLOWS.md §4.2 mobile header — `Eye` icon),
 * rendered at every width (owner correction, 2026-09-10): replaces the old
 * always-visible `TableViewControls` row *and* the standalone "show early
 * hours" toggle next to `WeekStrip` — every display option (list/table,
 * zoom, early hours, legend) lives only here now, on the board. Modeled on
 * `features/siddur/components/SiddurDisplayMenu.tsx` (same shape, plus a
 * "show legend" toggle) but kept as a sibling file so the member siddur
 * screen's own menu is untouched.
 */
export function BoardDisplayMenu({
  table, onTableChange, zoom, onZoomChange, showEarlyHours, onShowEarlyHoursChange, showLegend, onShowLegendChange,
}: BoardDisplayMenuProps) {
  const { landscape, rotateHint, enterLandscape, exitLandscape } = useLandscapeToggle(onTableChange);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={he.sadranBoard.displayMenu}
          data-testid="board-display-menu-trigger"
        >
          <Eye className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>{he.tableView.label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={table ? "table" : "cards"}
          onValueChange={(value) => {
            if (value === "table") onTableChange(true);
            else { onTableChange(false); void exitLandscape(); }
          }}
        >
          <DropdownMenuRadioItem value="cards"><List className="me-2 size-4" aria-hidden="true" />{he.tableView.cards}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="table"><Table2 className="me-2 size-4" aria-hidden="true" />{he.tableView.table}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {table ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={zoom <= 0.5}
              onSelect={(e) => { e.preventDefault(); onZoomChange(Math.max(0.5, Math.round((zoom - 0.1) * 10) / 10)); }}
            >
              <ZoomOut className="me-2 size-4" aria-hidden="true" />{he.tableView.zoomOut}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); onZoomChange(1); }}>
              <span className="me-2" dir="ltr">{Math.round(zoom * 100)}%</span>{he.tableView.resetZoom}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={zoom >= 1.5}
              onSelect={(e) => { e.preventDefault(); onZoomChange(Math.min(1.5, Math.round((zoom + 0.1) * 10) / 10)); }}
            >
              <ZoomIn className="me-2 size-4" aria-hidden="true" />{he.tableView.zoomIn}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); void (landscape ? exitLandscape() : enterLandscape()); }}>
              <RotateCw className="me-2 size-4" aria-hidden="true" />{landscape ? he.tableView.exitLandscape : he.tableView.landscape}
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={showEarlyHours}
          onCheckedChange={onShowEarlyHoursChange}
          onSelect={(e) => e.preventDefault()}
        >
          {showEarlyHours ? he.board.hideEarlyHours : he.board.showEarlyHours}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={showLegend}
          onCheckedChange={onShowLegendChange}
          onSelect={(e) => e.preventDefault()}
        >
          {showLegend ? he.sadranBoard.hideLegend : he.sadranBoard.showLegend}
        </DropdownMenuCheckboxItem>
        {rotateHint ? <p role="status" className="px-2 py-1.5 text-xs text-muted-foreground">{he.tableView.rotateHint}</p> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
