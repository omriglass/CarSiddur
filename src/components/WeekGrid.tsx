import type { MouseEvent, ReactNode } from "react";

import { formatMinutes } from "@/components/TimeField15";
import { he } from "@/i18n/he";
import { cn } from "@/lib/utils";

/**
 * Cars × 15-minute-columns grid for one day (component inventory `WeekGrid`,
 * UX_FLOWS.md §4.2/§3.5). **Layout only** — no data fetching, no dialogs, no
 * mutation calls (CLAUDE.md "React/UI" conventions, ui-dev.md scope): the
 * Sadran board (a later stage) reuses this same component with drag/resize
 * handlers wired through `onSlotClick`/`onRideClick`; the read-only siddur
 * (this stage) passes no mutation handlers, only `onRideClick` to open the
 * ride detail sheet. Kept under ~300 lines per the stage-2a brief.
 */
export interface WeekGridCar {
  id: string;
  name: string;
  /** Temporary cars render in a visually separate group at the bottom (UX_FLOWS §4.2). */
  group?: "shared" | "temporary";
  /** e.g. "בבנימינה" while away from home — shown next to the car name. */
  locationBadge?: string;
}

export interface WeekGridRide {
  id: string;
  carId: string;
  /** Minutes since local midnight, on the 15-minute grid. */
  startMinutes: number;
  endMinutes: number;
  label: string;
  pinned?: boolean;
  conflict?: boolean;
  pendingConsent?: boolean;
}

export interface WeekGridBlock {
  id: string;
  carId: string;
  startMinutes: number;
  endMinutes: number;
  label?: string;
}

export interface WeekGridProps {
  cars: readonly WeekGridCar[];
  rides: readonly WeekGridRide[];
  /** Maintenance/blocked windows, hatched (UX_FLOWS §7.4). */
  blocks?: readonly WeekGridBlock[];
  /** Grid start, default 05:00 (UX_FLOWS §4.2 "05:00-24:00"). */
  dayStartMinutes?: number;
  /** Grid end, default 24:00. */
  dayEndMinutes?: number;
  readOnly?: boolean;
  onRideClick?: (rideId: string) => void;
  onSlotClick?: (carId: string, minutes: number) => void;
  renderRide?: (ride: WeekGridRide) => ReactNode;
  /**
   * Sadran board additions (stage 2b, UX_FLOWS.md §4.2 drag/resize/merge-by-drop
   * interaction table) — kept additive and still layout-only: this component
   * only reports the *gesture result* (which ride, which car row, which
   * snapped minute), never calls a mutation or opens a dialog itself. Native
   * HTML5 drag-and-drop (`draggable`, `onDragStart`/`onDragOver`/`onDrop`)
   * rather than pointer tracking, to keep the added surface small.
   */
  draggable?: boolean;
  /** A ride block was dropped on car `carId` at `startMinutes`; `droppedOnRideId` is set when it landed on another block (merge-by-drag). */
  onRideDrop?: (rideId: string, carId: string, startMinutes: number, droppedOnRideId?: string) => void;
  /** One edge of a ride block was dragged to a new time (resize). */
  onRideResize?: (rideId: string, edge: "start" | "end", minutes: number) => void;
}

const DEFAULT_START = 5 * 60;
const DEFAULT_END = 24 * 60;
const ROW_HEIGHT_PX = 56;
const HOUR_WIDTH_PX = 64;

function clampPct(startMinutes: number, endMinutes: number, gridStart: number, gridEnd: number) {
  const total = gridEnd - gridStart;
  const left = ((Math.max(startMinutes, gridStart) - gridStart) / total) * 100;
  const width = ((Math.min(endMinutes, gridEnd) - Math.max(startMinutes, gridStart)) / total) * 100;
  return { left: `${left}%`, width: `${Math.max(width, 0.5)}%` };
}

function HourAxis({ hours }: { hours: number[] }) {
  return (
    <div className="flex" style={{ paddingInlineStart: 0 }}>
      {hours.map((h) => (
        <div
          key={h}
          className="shrink-0 border-e text-center text-xs text-muted-foreground"
          style={{ width: HOUR_WIDTH_PX }}
        >
          <span dir="ltr">{formatMinutes(h * 60)}</span>
        </div>
      ))}
    </div>
  );
}

function defaultRenderRide(ride: WeekGridRide) {
  return (
    <span className="truncate px-1.5 py-1 text-xs font-medium text-primary-foreground">
      {ride.label}
    </span>
  );
}

/**
 * One day, cars × time. Rows are plain flex rows with absolutely-positioned
 * ride blocks (percentage offsets from `dayStartMinutes`/`dayEndMinutes`) so
 * neither the 15-minute grid nor a full week of columns needs one DOM node
 * per cell — the wireframe's underlying gridlines are drawn once per hour.
 */
export function WeekGrid({
  cars,
  rides,
  blocks = [],
  dayStartMinutes = DEFAULT_START,
  dayEndMinutes = DEFAULT_END,
  readOnly = true,
  onRideClick,
  onSlotClick,
  renderRide,
  draggable = false,
  onRideDrop,
  onRideResize,
}: WeekGridProps) {
  const hours = Array.from(
    { length: Math.ceil((dayEndMinutes - dayStartMinutes) / 60) + 1 },
    (_, i) => Math.floor(dayStartMinutes / 60) + i,
  );
  const gridWidth = hours.length * HOUR_WIDTH_PX;

  const sharedCars = cars.filter((c) => c.group !== "temporary");
  const temporaryCars = cars.filter((c) => c.group === "temporary");

  function ridesFor(carId: string) {
    return rides.filter((r) => r.carId === carId);
  }
  function blocksFor(carId: string) {
    return blocks.filter((b) => b.carId === carId);
  }

  function minutesFromClientX(rect: DOMRect, clientX: number): number {
    const ratio = (clientX - rect.left) / rect.width;
    const minutes = dayStartMinutes + ratio * (dayEndMinutes - dayStartMinutes);
    return Math.round(minutes / 15) * 15;
  }

  function handleRowClick(carId: string, event: MouseEvent<HTMLDivElement>) {
    if (!onSlotClick || readOnly) return;
    const rect = event.currentTarget.getBoundingClientRect();
    onSlotClick(carId, minutesFromClientX(rect, event.clientX));
  }

  const dragEnabled = draggable && !readOnly && !!onRideDrop;
  const resizeEnabled = draggable && !readOnly && !!onRideResize;

  function Row({ car }: { car: WeekGridCar }) {
    return (
      <div key={car.id} className="flex items-stretch border-b" style={{ minWidth: gridWidth }}>
        <div
          className="relative flex-1"
          style={{ height: ROW_HEIGHT_PX, minWidth: gridWidth }}
          onClick={(e) => handleRowClick(car.id, e)}
          onDragOver={(e) => {
            if (dragEnabled) e.preventDefault();
          }}
          onDrop={(e) => {
            if (!dragEnabled) return;
            e.preventDefault();
            const rideId = e.dataTransfer.getData("text/plain");
            if (!rideId) return;
            const rect = e.currentTarget.getBoundingClientRect();
            onRideDrop?.(rideId, car.id, minutesFromClientX(rect, e.clientX));
          }}
          role={onSlotClick && !readOnly ? "button" : undefined}
        >
          {hours.map((h) => (
            <div
              key={h}
              className="absolute inset-y-0 border-e border-dashed border-border/60"
              style={clampPct(h * 60, h * 60, dayStartMinutes, dayEndMinutes)}
              aria-hidden="true"
            />
          ))}
          {blocksFor(car.id).map((b) => (
            <div
              key={b.id}
              className="absolute inset-y-1 rounded-sm border border-zinc-400 bg-[repeating-linear-gradient(45deg,theme(colors.zinc.300),theme(colors.zinc.300)_4px,theme(colors.zinc.100)_4px,theme(colors.zinc.100)_8px)]"
              style={clampPct(b.startMinutes, b.endMinutes, dayStartMinutes, dayEndMinutes)}
              title={b.label}
            />
          ))}
          {ridesFor(car.id).map((ride) => (
            <button
              key={ride.id}
              type="button"
              draggable={dragEnabled}
              className={cn(
                "absolute inset-y-1 flex items-center overflow-hidden rounded-sm bg-primary text-start",
                ride.conflict && "outline outline-2 outline-destructive",
                ride.pendingConsent && "border-2 border-dashed border-amber-500 bg-primary/60",
                onRideClick && "cursor-pointer",
              )}
              style={clampPct(ride.startMinutes, ride.endMinutes, dayStartMinutes, dayEndMinutes)}
              onClick={(e) => {
                e.stopPropagation();
                onRideClick?.(ride.id);
              }}
              onDragStart={(e) => {
                if (!dragEnabled) return;
                e.dataTransfer.setData("text/plain", ride.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (dragEnabled) e.preventDefault();
              }}
              onDrop={(e) => {
                if (!dragEnabled) return;
                e.preventDefault();
                e.stopPropagation();
                const sourceRideId = e.dataTransfer.getData("text/plain");
                if (!sourceRideId || sourceRideId === ride.id) return;
                onRideDrop?.(sourceRideId, ride.carId, ride.startMinutes, ride.id);
              }}
              aria-label={ride.label}
            >
              {resizeEnabled ? (
                <span
                  draggable
                  className="absolute inset-y-0 start-0 w-2 cursor-ew-resize"
                  aria-hidden="true"
                  onClick={(e) => e.stopPropagation()}
                  onDragStart={(e) => {
                    e.stopPropagation();
                    e.dataTransfer.setData("text/plain", ride.id);
                  }}
                  onDragEnd={(e) => {
                    const parentRect = e.currentTarget.parentElement?.parentElement?.getBoundingClientRect();
                    if (!parentRect) return;
                    onRideResize?.(ride.id, "start", minutesFromClientX(parentRect, e.clientX));
                  }}
                />
              ) : null}
              {renderRide ? renderRide(ride) : defaultRenderRide(ride)}
              {resizeEnabled ? (
                <span
                  draggable
                  className="absolute inset-y-0 end-0 w-2 cursor-ew-resize"
                  aria-hidden="true"
                  onClick={(e) => e.stopPropagation()}
                  onDragStart={(e) => {
                    e.stopPropagation();
                    e.dataTransfer.setData("text/plain", ride.id);
                  }}
                  onDragEnd={(e) => {
                    const parentRect = e.currentTarget.parentElement?.parentElement?.getBoundingClientRect();
                    if (!parentRect) return;
                    onRideResize?.(ride.id, "end", minutesFromClientX(parentRect, e.clientX));
                  }}
                />
              ) : null}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <div style={{ minWidth: gridWidth + 128 }}>
        <div className="flex border-b bg-muted/40">
          <div className="w-32 shrink-0" />
          <HourAxis hours={hours} />
        </div>
        {sharedCars.map((car) => (
          <div key={car.id} className="flex">
            <div className="flex w-32 shrink-0 flex-col justify-center gap-0.5 border-e px-2 text-sm">
              <span className="truncate font-medium">{car.name}</span>
              {car.locationBadge ? (
                <span className="truncate text-xs text-muted-foreground">{car.locationBadge}</span>
              ) : null}
            </div>
            <Row car={car} />
          </div>
        ))}
        {temporaryCars.length > 0 ? (
          <div className="flex bg-sky-50/60">
            <div className="w-32 shrink-0 border-e px-2 py-1 text-xs text-muted-foreground">
              {he.car.type.temporary}
            </div>
            <div className="flex-1" />
          </div>
        ) : null}
        {temporaryCars.map((car) => (
          <div key={car.id} className="flex bg-sky-50/40">
            <div className="flex w-32 shrink-0 items-center border-e px-2 text-sm">
              <span className="truncate font-medium">{car.name}</span>
            </div>
            <Row car={car} />
          </div>
        ))}
      </div>
    </div>
  );
}
