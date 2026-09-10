import { List, RotateCw, Table2, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLandscapeToggle } from "@/components/useLandscapeToggle";
import { he } from "@/i18n/he";

interface Props {
  table: boolean;
  onTableChange: (table: boolean) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
}

/**
 * Desktop-inline cards/table + zoom + landscape row (`hidden` below `md` —
 * `SiddurDisplayMenu` is the mobile equivalent of the same options, sharing
 * `useLandscapeToggle` so the fullscreen/orientation-lock logic isn't
 * duplicated between the two renderings).
 */
export function TableViewControls({ table, onTableChange, zoom, onZoomChange }: Props) {
  const { landscape, rotateHint, enterLandscape, exitLandscape } = useLandscapeToggle(onTableChange);

  return <div className={landscape ? "space-y-2" : "space-y-2 lg:hidden"}>
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={he.tableView.label}>
      <Button size="sm" variant={table ? "outline" : "default"} aria-pressed={!table} onClick={() => { onTableChange(false); void exitLandscape(); }}><List className="size-4" />{he.tableView.cards}</Button>
      <Button size="sm" variant={table ? "default" : "outline"} aria-pressed={table} onClick={() => onTableChange(true)}><Table2 className="size-4" />{he.tableView.table}</Button>
      {table ? <>
        <Button size="icon" variant="outline" aria-label={he.tableView.zoomOut} disabled={zoom <= 0.5} onClick={() => onZoomChange(Math.max(0.5, Math.round((zoom - 0.1) * 10) / 10))}><ZoomOut className="size-4" /></Button>
        <Button size="sm" variant="ghost" aria-label={he.tableView.resetZoom} onClick={() => onZoomChange(1)}><span dir="ltr">{Math.round(zoom * 100)}%</span></Button>
        <Button size="icon" variant="outline" aria-label={he.tableView.zoomIn} disabled={zoom >= 1.5} onClick={() => onZoomChange(Math.min(1.5, Math.round((zoom + 0.1) * 10) / 10))}><ZoomIn className="size-4" /></Button>
        <Button size="sm" variant="outline" aria-pressed={landscape} onClick={() => void (landscape ? exitLandscape() : enterLandscape())}><RotateCw className="size-4" />{landscape ? he.tableView.exitLandscape : he.tableView.landscape}</Button>
      </> : null}
    </div>
    {rotateHint ? <p role="status" className="text-sm text-muted-foreground">{he.tableView.rotateHint}</p> : null}
  </div>;
}
