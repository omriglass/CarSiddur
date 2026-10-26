import { Eye, List, Table2, ZoomIn, ZoomOut } from "lucide-react";

import { PINCH_ZOOM_MAX, PINCH_ZOOM_MIN, zoomIn, zoomOut } from "@/components/pinchZoom";
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
import { he } from "@/i18n/he";

interface MyWeekDisplayMenuProps {
  view: "list" | "week";
  onViewChange: (view: "list" | "week") => void;
  /** Only in the week view (the list has nothing to zoom). */
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
  /** Owner 2026-10-16: also show my children's rides (read-only), saved per device. Omitted = no such option. */
  showKidsRides?: boolean;
  onShowKidsRidesChange?: (show: boolean) => void;
}

/**
 * The "eye" menu of `/my` (owner 2026-10-11), same pattern and styling as the siddur's `SiddurDisplayMenu`: the
 * list / week choice (remembered on this device; `?view=` wins for one visit) and, in the week view, the zoom out / reset / in items.
 */
export function MyWeekDisplayMenu({ view, onViewChange, zoom, onZoomChange, showKidsRides, onShowKidsRidesChange }: MyWeekDisplayMenuProps) {
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
        {onShowKidsRidesChange ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={!!showKidsRides} onCheckedChange={(checked) => onShowKidsRidesChange(checked === true)} onSelect={(e) => e.preventDefault()} data-testid="my-show-kids-rides">
              {he.myWeek.showKidsRides}
            </DropdownMenuCheckboxItem>
          </>
        ) : null}
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
