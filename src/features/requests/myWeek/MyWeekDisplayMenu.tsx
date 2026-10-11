import { Eye, List, Table2, ZoomIn, ZoomOut } from "lucide-react";

import { PINCH_ZOOM_MAX, PINCH_ZOOM_MIN, zoomIn, zoomOut } from "@/components/pinchZoom";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { he } from "@/i18n/he";

interface MyWeekDisplayMenuProps {
  view: "list" | "week";
  onViewChange: (view: "list" | "week") => void;
  /** Only in the week view (the list has nothing to zoom). */
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
}

/**
 * The "eye" menu of `/my` (owner 2026-10-11), same pattern and styling as the siddur's `SiddurDisplayMenu`: the
 * list / week choice (this visit only, `?view=`) and, in the week view, the zoom out / reset / in items.
 */
export function MyWeekDisplayMenu({ view, onViewChange, zoom, onZoomChange }: MyWeekDisplayMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="icon" aria-label={he.siddur.displayMenu} data-testid="my-display-menu-trigger">
          <Eye className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>{he.myWeek.viewToggleLabel}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={view} onValueChange={(next) => { if (next === "list" || next === "week") onViewChange(next); }}>
          <DropdownMenuRadioItem value="list" data-testid="my-view-list"><List className="me-2 size-4" aria-hidden="true" />{he.myWeek.viewList}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="week" data-testid="my-view-week"><Table2 className="me-2 size-4" aria-hidden="true" />{he.myWeek.viewWeek}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {view === "week" && zoom !== undefined && onZoomChange ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={zoom <= PINCH_ZOOM_MIN} onSelect={(e) => { e.preventDefault(); onZoomChange(zoomOut(zoom)); }}>
              <ZoomOut className="me-2 size-4" aria-hidden="true" />{he.tableView.zoomOut}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); onZoomChange(1); }}>
              <span className="me-2" dir="ltr">{Math.round(zoom * 100)}%</span>{he.tableView.resetZoom}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={zoom >= PINCH_ZOOM_MAX} onSelect={(e) => { e.preventDefault(); onZoomChange(zoomIn(zoom)); }}>
              <ZoomIn className="me-2 size-4" aria-hidden="true" />{he.tableView.zoomIn}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
