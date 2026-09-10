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

interface SiddurDisplayMenuProps {
  table: boolean;
  onTableChange: (table: boolean) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  showEarlyHours: boolean;
  onShowEarlyHoursChange: (value: boolean) => void;
}

/**
 * Mobile "display" icon menu (UX_FLOWS.md member siddur "mobile header" —
 * end side, `Eye` icon): every option `TableViewControls` renders inline on
 * desktop, collapsed into one menu, plus the "show early hours" toggle.
 * Shares `useLandscapeToggle` with `TableViewControls` so the fullscreen/
 * orientation-lock logic is written once. Zoom/landscape/early-hours items
 * only make sense once table view is on — hidden otherwise, same as the
 * desktop row.
 */
export function SiddurDisplayMenu({
  table, onTableChange, zoom, onZoomChange, showEarlyHours, onShowEarlyHoursChange,
}: SiddurDisplayMenuProps) {
  const { landscape, rotateHint, enterLandscape, exitLandscape } = useLandscapeToggle(onTableChange);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={he.siddur.displayMenu}
          data-testid="siddur-display-menu-trigger"
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
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={showEarlyHours}
              onCheckedChange={onShowEarlyHoursChange}
              onSelect={(e) => e.preventDefault()}
            >
              {showEarlyHours ? he.board.hideEarlyHours : he.board.showEarlyHours}
            </DropdownMenuCheckboxItem>
          </>
        ) : null}
        {rotateHint ? <p role="status" className="px-2 py-1.5 text-xs text-muted-foreground">{he.tableView.rotateHint}</p> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
