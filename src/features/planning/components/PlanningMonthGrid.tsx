import { Car } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { MonthEventBlock } from "@/features/calendar/monthBlocks";
import { he, tv } from "@/i18n/he";
import { cn } from "@/lib/utils";

import type { PlanningDay } from "../api";
import { monthGridDates } from "../monthGrid";
import { planningPinchZoom } from "../zoom";
import type { StarTier } from "../rank";

const STARS: Record<StarTier, string> = { 3: "★★★", 2: "★★", 1: "★" };

interface PlanningMonthGridProps {
  month: string;
  days: ReadonlyMap<string, PlanningDay>;
  plannable: (day: PlanningDay) => boolean;
  /** The day's whole-day load (0..1+), for the shading of plannable days. */
  loadOf: (day: PlanningDay) => number;
  stars: ReadonlyMap<string, StarTier>;
  events: ReadonlyMap<string, MonthEventBlock[]>;
  onDayClick: (date: string) => void;
  /** 1 = the whole month on screen; larger scrolls (− / + on the page, or a two-finger pinch here). */
  zoom: number;
  onZoomChange: (zoom: number) => void;
}

/**
 * REQ §13.154 (c)/(d)/(f): one month. A plannable day is shaded by its load and shows its reservation count (nothing
 * when none); past days and weeks already open are grey with their rides (published) or requests count; the helper's
 * best options carry an orange top bar and stars; the member's calendar events are faint blocks, one per event.
 */
export function PlanningMonthGrid({ month, days, plannable, loadOf, stars, events, onDayClick, zoom, onZoomChange }: PlanningMonthGridProps) {
  const dates = monthGridDates(month);
  const weeks = Array.from({ length: dates.length / 7 }, (_, i) => dates.slice(i * 7, i * 7 + 7));
  const viewportRef = useRef<HTMLDivElement>(null);
  // The grid keeps the viewport's own width before zooming, so zooming in widens it (and scrolls) instead of squeezing.
  const [baseWidth, setBaseWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setBaseWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Same pinch wiring as `WeekGrid`: refs so the listeners survive the re-renders the gesture itself causes.
  const zoomRef = useRef(zoom);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  const onZoomChangeRef = useRef(onZoomChange);
  useEffect(() => { onZoomChangeRef.current = onZoomChange; }, [onZoomChange]);
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    let pinch: { startDist: number; startZoom: number } | null = null;
    let rafId = 0;
    const distance = (touches: TouchList) => {
      const a = touches.item(0);
      const b = touches.item(1);
      return a && b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0;
    };
    const onStart = (e: TouchEvent) => { if (e.touches.length === 2) pinch = { startDist: distance(e.touches), startZoom: zoomRef.current }; };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !pinch) return;
      e.preventDefault();
      const dist = distance(e.touches);
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => { if (pinch) onZoomChangeRef.current(planningPinchZoom(pinch.startZoom, pinch.startDist, dist)); });
    };
    const onEnd = (e: TouchEvent) => { if (e.touches.length < 2) pinch = null; };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      cancelAnimationFrame(rafId);
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, []);
  return (
    <div ref={viewportRef} className="overflow-auto" style={{ touchAction: "pan-x pan-y" }} data-testid="planning-month-viewport">
    <div className="space-y-1.5" style={{ zoom, width: baseWidth && zoom > 1 ? `${baseWidth}px` : undefined }} data-testid="planning-month">
      <div className="flex gap-1 lg:gap-1.5">
        {he.days.short.map((letter, i) => (
          <span key={i} className="flex-1 text-center text-xs font-semibold text-muted-foreground lg:text-sm">
            <span className="lg:hidden">{letter}</span>
            <span className="hidden lg:inline">{he.days.long[i]}</span>
          </span>
        ))}
      </div>
      {weeks.map((week) => (
        <div key={week[0]} className="flex gap-1 lg:gap-1.5">
          {week.map((date) => {
            const inMonth = date.startsWith(month);
            const day = days.get(date);
            const open = day ? plannable(day) : false;
            const tier = inMonth ? stars.get(date) : undefined;
            const dayEvents = inMonth ? (events.get(date) ?? []) : [];
            const load = day && open ? Math.min(1, loadOf(day)) : 0;
            const reservations = day?.reservationIds.length ?? 0;
            const shownCount = !day ? 0 : open ? reservations : day.rides > 0 || day.phase === "published" || day.phase === "live" || day.phase === "archived" ? day.rides : day.requests;
            const countLabel = !day ? "" : open
              ? tv("planning.countReservations", { n: String(reservations) })
              : day.rides > 0 || day.phase === "published" || day.phase === "live" || day.phase === "archived"
                ? tv("planning.countRides", { n: String(day.rides) })
                : tv("planning.countRequests", { n: String(day.requests) });
            return (
              <button
                key={date}
                type="button"
                disabled={!inMonth || !day}
                onClick={() => onDayClick(date)}
                data-testid={`planning-cell-${date}`}
                data-tier={tier ?? ""}
                aria-label={[date.slice(8).replace(/^0/, ""), shownCount > 0 ? countLabel : "", tier ? he.planning.tiers[tier] : ""].filter(Boolean).join(", ")}
                className={cn(
                  "relative flex h-16 min-w-0 flex-1 flex-col overflow-hidden rounded-lg text-start lg:h-28",
                  open ? "bg-card ring-1 ring-inset ring-border" : "bg-muted/70 text-muted-foreground",
                  !inMonth && "invisible",
                  tier && "ring-[1.5px] ring-orange-600",
                )}
                style={open && load > 0 ? { backgroundColor: `hsl(var(--primary) / ${(0.06 + 0.34 * load).toFixed(2)})` } : undefined}
              >
                {tier ? <span className="absolute inset-x-0 top-0 h-1 bg-orange-600 lg:h-1.5" aria-hidden="true" /> : null}
                <span className="flex items-start justify-between px-1 pt-1 lg:px-2 lg:pt-2">
                  <span className="text-xs font-semibold lg:text-sm">{Number(date.slice(8))}</span>
                  {tier ? <span className="text-[10px] leading-none tracking-[-1px] text-orange-700 lg:text-base lg:tracking-normal dark:text-orange-400" aria-hidden="true">{STARS[tier]}</span> : null}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5 px-0.5 pt-0.5 lg:gap-1 lg:px-1.5">
                  {dayEvents.slice(0, 2).map((event, i) => (
                    <span
                      key={`${event.id}-${i}`}
                      className="block truncate rounded bg-violet-100/90 px-1 text-[9px] leading-[13px] text-violet-900 dark:bg-violet-900/60 dark:text-violet-100 lg:text-xs lg:leading-[18px]"
                    >
                      {event.title}
                    </span>
                  ))}
                </span>
                {shownCount > 0 ? (
                  <span className="absolute bottom-0.5 start-1 flex items-center gap-0.5 text-[10px] font-semibold lg:bottom-1.5 lg:start-2 lg:gap-1 lg:text-sm" data-testid="planning-cell-count">
                    <Car className="size-3 lg:size-4" aria-hidden="true" />
                    <span dir="ltr">{shownCount}</span>
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
    </div>
  );
}
