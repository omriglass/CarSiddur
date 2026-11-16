// REQ item 246 (LT1): the stop-hours pieces of the stops editor — the hour beside a place (fixed:
// dark with a lock; worked out: dashed with "~"), the per-stop editor (stay, fixed hour, time,
// flexibility) and the "where on the route?" options for an added stop (owner 2026-11-16:
// "before Metzer or after", each with what changes; fixed hours never move).
import { Lock } from "lucide-react";
import { useMemo, useState } from "react";

import type { DestinationValue } from "@/components/DestinationCombobox";
import { Button } from "@/components/ui/button";
import { he, tv } from "@/i18n/he";
import { insertOptions, type InsertOption, type SchedulePoint, type StopAnchor } from "@/lib/stopSchedule";
import { cn } from "@/lib/utils";

import { useRouteHopsQuery } from "../../routeHopsQuery";
import { clock, durationLabel } from "./stopHoursLabels";
import {
  STOP_FLEX_MINUTES, STOP_STAY_MINUTES, hopPairs, pairTravel, schedulePlace,
  type HopMinutes, type StopHoursValue, type StopRouteValues,
} from "../../stopHours";

export interface HourChipProps {
  /** The label line ("להגיע עד" / "הגעה משוערת" …). */
  label: string;
  minutes: number;
  fixed: boolean;
  flex?: number;
  onClick?: () => void;
  ariaLabel?: string;
  open?: boolean;
  testId?: string;
}

export function HourChip({ label, minutes, fixed, flex, onClick, ariaLabel, open, testId }: HourChipProps) {
  const body = (
    <>
      <span className="flex items-center gap-1 text-[11px] leading-tight">
        {fixed ? <Lock className="size-3" aria-hidden="true" /> : null}
        {label}
      </span>
      <span dir="ltr" className="text-base font-bold leading-tight">{fixed ? clock(minutes) : tv("request.stopHoursApprox", { time: clock(minutes) })}</span>
      {fixed && flex ? <span className="text-[11px] leading-tight">{tv("request.stopHoursFlexBadge", { minutes: String(flex) })}</span> : null}
    </>
  );
  const className = cn(
    "flex min-h-11 min-w-[5.5rem] shrink-0 flex-col items-center justify-center rounded-lg px-2 py-1",
    fixed ? "bg-primary text-primary-foreground" : "border border-dashed border-muted-foreground/60 text-muted-foreground",
    open && "ring-2 ring-primary ring-offset-1",
  );
  return onClick ? (
    <button type="button" className={className} onClick={onClick} aria-label={ariaLabel} data-testid={testId} data-fixed={fixed ? "true" : "false"}>{body}</button>
  ) : (
    <div className={className} data-testid={testId} data-fixed={fixed ? "true" : "false"}>{body}</div>
  );
}

interface StopHoursEditorProps {
  hours: StopHoursValue;
  /** The hour now shown for the place (prefills the time when fixing). */
  shownMinutes: number;
  onApply: (hours: StopHoursValue) => void;
  onCancel: () => void;
}

export function StopHoursEditor({ hours, shownMinutes, onApply, onCancel }: StopHoursEditorProps) {
  const [draft, setDraft] = useState<StopHoursValue>(() => ({ ...hours, time: hours.time ?? clock(shownMinutes) }));
  const choose = (anchor: StopAnchor | null) => setDraft((d) => ({ ...d, anchor }));
  const option = (selected: boolean) => cn("min-h-11 w-full justify-start whitespace-normal text-start", selected && "border-2 border-primary text-primary");
  return (
    <div className="mt-2 space-y-3 rounded-lg border bg-muted/40 p-3" data-testid="stop-hours-editor">
      <label className="block space-y-1 text-sm font-medium">
        <span>{he.request.stopHoursStayLabel}</span>
        <select
          className="h-11 w-full rounded-md border bg-background px-2 text-base"
          data-testid="stop-hours-stay"
          value={draft.stay === null ? "" : String(draft.stay)}
          onChange={(e) => setDraft((d) => ({ ...d, stay: e.target.value === "" ? null : Number(e.target.value) }))}
        >
          <option value="">{he.request.stopHoursStayUnset}</option>
          {STOP_STAY_MINUTES.map((m) => <option key={m} value={String(m)}>{durationLabel(m)}</option>)}
        </select>
        <span className="block text-xs font-normal text-muted-foreground">{he.request.stopHoursStayHint}</span>
      </label>
      <div className="space-y-1.5">
        <div className="text-sm font-medium">{he.request.stopHoursFixedQuestion}</div>
        <Button type="button" variant="outline" className={option(draft.anchor === null)} onClick={() => choose(null)} data-testid="stop-hours-none">{he.request.stopHoursFixedNone}</Button>
        <Button type="button" variant="outline" className={option(draft.anchor === "arrive")} onClick={() => choose("arrive")} data-testid="stop-hours-arrive">{he.request.stopHoursFixedArrive}</Button>
        <Button type="button" variant="outline" className={option(draft.anchor === "leave")} onClick={() => choose("leave")} data-testid="stop-hours-leave">{he.request.stopHoursFixedLeave}</Button>
      </div>
      {draft.anchor ? (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-2 dark:bg-amber-950/30">
          <label className="flex items-center gap-2 text-sm">
            <span className="min-w-[5.5rem]">{draft.anchor === "arrive" ? he.request.stopHoursTimeArrive : he.request.stopHoursTimeLeave}</span>
            <input
              type="time" step={300} dir="ltr" data-testid="stop-hours-time"
              className="h-11 rounded-md border bg-background px-2 text-base"
              value={draft.time ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, time: e.target.value || null }))}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="min-w-[5.5rem]">{he.request.stopHoursFlexLabel}</span>
            <select
              className="h-11 rounded-md border bg-background px-2 text-base" data-testid="stop-hours-flex"
              value={String(draft.flex)}
              onChange={(e) => setDraft((d) => ({ ...d, flex: Number(e.target.value) }))}
            >
              {STOP_FLEX_MINUTES.map((m) => (
                <option key={m} value={String(m)}>{m ? tv("request.stopHoursFlexOption", { minutes: String(m) }) : he.request.stopHoursFlexNone}</option>
              ))}
            </select>
          </label>
          <p className="text-xs text-amber-900 dark:text-amber-200">{draft.anchor === "arrive" ? he.request.stopHoursHelpArrive : he.request.stopHoursHelpLeave}</p>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button" data-testid="stop-hours-apply"
          disabled={draft.anchor !== null && !draft.time}
          onClick={() => onApply(draft.anchor ? draft : { ...draft, time: null, flex: 0 })}
        >
          {draft.anchor ? he.request.stopHoursApplyFixed : he.request.stopHoursApply}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>{he.request.stopHoursBack}</Button>
      </div>
    </div>
  );
}

export interface PickedOption {
  leg: "out" | "return";
  /** Index in the current points list to insert before. */
  beforeIndex: number;
  /** Given stays the option shortens: point key -> minutes. */
  shortened: { key: string; minutes: number }[];
}

interface AddStopOptionsProps {
  departmentId: string;
  values: StopRouteValues;
  points: readonly SchedulePoint[];
  hops: HopMinutes;
  place: DestinationValue;
  placeName: string;
  /** Name of the place at a point key. */
  nameOf: (key: string) => string;
  defaultStart: number;
  onPick: (picked: PickedOption) => void;
}

const NEW_KEY = "new";

export function AddStopOptions({ departmentId, values, points, hops, place, placeName, nameOf, defaultStart, onPick }: AddStopOptionsProps) {
  const newPlace = schedulePlace(place);
  // One priced zig-zag (p0, new, p1, new, …) holds every hop an insertion needs.
  const zigzag = useMemo(() => {
    const preview = points.flatMap((p, i) => {
      const at = p.place;
      const asPreview = (key: string) => (key.startsWith("p:") ? { place_id: key.slice(2), place_text: null } : { place_id: null, place_text: key.slice(2) });
      const out = [asPreview(at)];
      if (i < points.length - 1) out.push(asPreview(newPlace));
      return out;
    });
    return preview;
  }, [points, newPlace]);
  const zigzagPlaces = useMemo(() => points.flatMap((p, i) => (i < points.length - 1 ? [p.place, newPlace] : [p.place])), [points, newPlace]);
  const hopsQuery = useRouteHopsQuery(departmentId, zigzag, true);

  const options = useMemo(() => {
    if (!hopsQuery.data) return null;
    const travel = pairTravel(hopPairs(points.map((p) => p.place), hops.hops), hopPairs(zigzagPlaces, hopsQuery.data.hops));
    const added: SchedulePoint = { key: NEW_KEY, place: newPlace, kind: "stop", stay: null, fixed: null };
    const opts = { travel, stopMinutes: hops.stopMinutes, defaultStart };
    const tag = (leg: "out" | "return") => (o: InsertOption) => ({ leg, o });
    return [
      ...insertOptions(points, "out", added, opts).map(tag("out")),
      ...(values.hasReturn ? insertOptions(points, "return", added, opts).map(tag("return")) : []),
    ].sort((x, y) => x.o.cost - y.o.cost || (x.leg === y.leg ? x.o.beforeIndex - y.o.beforeIndex : x.leg === "out" ? -1 : 1));
  }, [hopsQuery.data, points, hops, zigzagPlaces, newPlace, defaultStart, values.hasReturn]);

  if (!options) return <p className="text-sm text-muted-foreground">{he.request.stopOptionsLoading}</p>;
  const bestIndex = options.findIndex((x) => x.o.ok);
  return (
    <div className="space-y-2" data-testid="stop-options">
      <div className="text-base font-semibold">{he.request.stopOptionsTitle}</div>
      <p className="text-xs text-muted-foreground">{he.request.stopOptionsHint}</p>
      {options.map(({ leg, o }, i) => {
        const next = points[o.beforeIndex];
        const prev = points[o.beforeIndex - 1];
        const legLabel = leg === "out" ? he.request.stopOptionOut : he.request.stopOptionReturn;
        const label = next?.kind === "stop" ? tv("request.stopOptionBefore", { leg: legLabel, place: nameOf(next.key) })
          : prev?.kind === "stop" ? tv("request.stopOptionAfter", { leg: legLabel, place: nameOf(prev.key) })
          : legLabel;
        const at = (key: string) => o.schedule.points.find((p) => p.key === key);
        const lines: { text: string; flex?: boolean }[] = [];
        // Owner 2026-11-16: hours that cannot all be kept are a warning, never a refusal - the option can still be added.
        if (!o.ok) {
          const c = o.schedule.conflict;
          lines.push({ flex: true, text: tv("request.stopTight", { place: c ? nameOf(c.key) : "" }) });
        } else {
          lines.push({ text: tv("request.stopOptionEta", { place: placeName, time: clock(o.newArrive) }) });
          if (o.departEarlier > 0) lines.push({ text: tv("request.stopOptionDepartEarlier", { time: clock(o.schedule.points[0]?.leave ?? 0), minutes: String(o.departEarlier) }) });
          if (o.destLeaveEarlier > 0) lines.push({ text: tv("request.stopOptionDestLess", { minutes: String(o.destLeaveEarlier), place: nameOf("dest"), time: clock(at("dest")?.leave ?? 0) }) });
          for (const s of o.shortened) lines.push({ text: tv("request.stopOptionShortened", { minutes: String(s.minutes), place: nameOf(s.key) }) });
          for (const f of o.flexUsed) lines.push({ flex: true, text: tv("request.stopOptionFlex", { place: nameOf(f.key), time: clock(at(f.key)?.arrive ?? 0) }) });
          if (o.homeLater > 0) lines.push({ text: tv("request.stopOptionHomeLater", { time: clock(o.schedule.points[o.schedule.points.length - 1]?.arrive ?? 0), minutes: String(o.homeLater) }) });
          if (lines.length === 1) lines.push({ text: he.request.stopOptionNoChange });
        }
        return (
          <div
            key={`${leg}:${o.beforeIndex}`}
            className={cn("space-y-1 rounded-lg border p-3", o.ok ? "border-primary/30 bg-primary/5" : "bg-muted")}
            data-testid="stop-option"
            data-ok={o.ok ? "true" : "false"}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">{label}</span>
              {i === bestIndex ? <span className="rounded bg-green-100 px-2 text-xs font-medium text-green-900 dark:bg-green-900/40 dark:text-green-100">{he.request.stopOptionBest}</span> : null}
            </div>
            {lines.map((line, k) => (
              <div key={k} className={cn("text-sm", line.flex && "w-fit rounded bg-amber-100 px-1 text-amber-950 dark:bg-amber-900/40 dark:text-amber-100")}>{line.text}</div>
            ))}
            <Button type="button" size="sm" variant={o.ok ? "default" : "outline"} className="mt-1 min-h-11" data-testid="stop-option-add"
              onClick={() => onPick({ leg, beforeIndex: o.beforeIndex, shortened: o.shortened.filter((s) => s.key !== NEW_KEY) })}>
              {he.request.stopOptionAdd}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
