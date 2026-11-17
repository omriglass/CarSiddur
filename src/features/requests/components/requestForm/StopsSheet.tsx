// REQUIREMENTS §13.93 "Multi-stop rides" / UX_FLOWS "Stops, built 2026-11-08" (TODO ST1 rework):
// the stops editor, shared by the classic and the sentence form. One sheet with ONE ordered
// list: origin (fixed) -> out stops -> destination (fixed) -> return stops -> origin (fixed; the
// return part only with a return leg). Tap origin/destination to change them, drag a stop by
// its grip (pointer events; arrow keys on the grip) to reorder or move it across the destination
// into the other leg, "+ הוספת עצירה" between blocks adds one there. The position decides the leg
// (pure logic: stopsModel.ts). The picker is the inline `PlacePicker` — no second floating layer.
import { GripVertical, X } from "lucide-react";
import { Fragment, useRef, useState, type ReactNode } from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";

import type { DestinationValue } from "@/components/DestinationCombobox";
import { he, tv } from "@/i18n/he";
import { cn } from "@/lib/utils";

import type { RequestFormValues } from "../../schema";
import { stopHoursOf, withStopHours, type StopHoursRecord } from "../../stopHours";
import { timeToMinutes } from "../../duration";
import { AddStopOptions, HourChip, StopHoursEditor, type PickedOption } from "./StopHours";
import { clock, durationLabel } from "./stopHoursLabels";
import { useStopSchedule } from "./useStopSchedule";
import { FieldSheet } from "./sentence/FieldSheet";
import { PlacePicker, type PlaceOption } from "./sentence/PlacePicker";
import { placeName, legAt, type Leg, fromBlocks, insertStop, addPosition, moveStop, nudgeStop, removeBlock, replaceStop, toBlocks, type StopBlock } from "./stopsModel";

type Picking = null | { kind: "origin" | "destination" } | { kind: "add"; index: number } | { kind: "edit"; index: number };

interface StopsSheetProps {
  form: UseFormReturn<RequestFormValues>;
  /** All the department's places (the origin picker offers every one; stops and destination skip the origin). */
  places: readonly PlaceOption[];
  /** The trip has a return leg (round trip, or הקפצה with a pickup). */
  hasReturn: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * REQ item 249 (owner 2026-11-17): the way's own time editor (the sentence form's time sheet), so the hours at the
   * route's ends - leave home, at the destination by, leave it at, home by - are edited from here too. Absent = the
   * end hours are shown only (the classic form).
   */
  renderEndHours?: (end: "out" | "return") => ReactNode;
}

export function StopsSheet({ form, places, hasReturn, open, onOpenChange, renderEndHours }: StopsSheetProps) {
  const [origin, destination, outStops, returnStops] = useWatch({
    control: form.control,
    name: ["origin", "destination", "outStops", "returnStops"],
  }) as [DestinationValue | null, DestinationValue | null, DestinationValue[] | undefined, DestinationValue[] | undefined];
  const hiddenReturn = returnStops ?? [];
  const blocks = toBlocks({ outStops: outStops ?? [], returnStops: hiddenReturn }, hasReturn);
  const [picking, setPicking] = useState<Picking>(null);
  // REQ item 246: the stop whose hours are being edited, and a picked place waiting for "where on the route?".
  const [editingHours, setEditingHours] = useState<number | null>(null);
  const [addingPlace, setAddingPlace] = useState<DestinationValue | null>(null);
  const [editingEnd, setEditingEnd] = useState<"out" | "return" | null>(null);
  const stopHours = useWatch({ control: form.control, name: "stopHours" }) as StopHoursRecord | undefined;
  const timing = useStopSchedule(form, hasReturn, open);
  const [drag, setDrag] = useState<{ from: number; at: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const originName = placeName(origin, places);
  const destinationName = placeName(destination, places);
  const originPresetId = origin && "presetId" in origin ? origin.presetId : undefined;
  const placesWithoutOrigin = places.filter((place) => place.id !== originPresetId);

  function commit(next: StopBlock[]) {
    const lists = fromBlocks(next, hasReturn, hiddenReturn);
    form.setValue("outStops", [...lists.outStops], { shouldDirty: true, shouldValidate: true });
    form.setValue("returnStops", [...lists.returnStops], { shouldDirty: true, shouldValidate: true });
  }

  function close(next: boolean) {
    if (!next) { setPicking(null); setDrag(null); setEditingHours(null); setAddingPlace(null); setEditingEnd(null); }
    onOpenChange(next);
  }

  function pick(value: DestinationValue) {
    if (!picking) return;
    if (picking.kind === "origin" || picking.kind === "destination") {
      form.setValue(picking.kind, value, { shouldDirty: true, shouldValidate: true });
    } else if (picking.kind === "add") {
      // REQ item 246: with the route priced, offer every position with what changes (owner 2026-11-16).
      if (timing.schedule && timing.hops && timing.values) setAddingPlace(value);
      else commit(insertStop(blocks, picking.index, value));
    } else if (picking.kind === "edit") {
      commit(replaceStop(blocks, picking.index, value));
    }
    setPicking(null);
  }

  function dropIndexAt(clientY: number): number {
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-block-index]") ?? []);
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return Math.max(1, Number(row.dataset.blockIndex));
    }
    return blocks.length - 1;
  }

  const addIndex = addPosition(blocks);

  // REQ item 246: the schedule point of a block (keys as in SQL request_schedule).
  const destinationAt = blocks.findIndex((b) => b.kind === "destination");
  const outValues = outStops ?? [];
  function nameOf(key: string): string {
    if (key === "start" || key === "end") return originName;
    if (key === "dest" || key === "back") return destinationName;
    const [leg, pos] = key.split(":");
    const list = leg === "out" ? outValues : hiddenReturn;
    return placeName(list[Number(pos) - 1], places);
  }
  const pointOf = (key: string) => timing.schedule?.points.find((p) => p.key === key);
  const fixedOf = (key: string) => timing.points.find((p) => p.key === key)?.fixed ?? null;
  function stopKey(index: number): { leg: Leg; key: string; value: DestinationValue } | null {
    const block = blocks[index];
    if (!block || block.kind !== "stop") return null;
    const leg = legAt(blocks, index);
    const position = leg === "out" ? index : index - destinationAt;
    return { leg, key: `${leg}:${position}`, value: block.value };
  }
  function chipFor(key: string, which: "arrive" | "leave", testId: string, onClick?: () => void, isOpen?: boolean) {
    const point = pointOf(key);
    if (!point) return null;
    const fixed = fixedOf(key);
    const label = fixed
      ? (fixed.anchor === "leave" ? he.request.stopHoursLeaveAt : key === "end" ? he.request.stopHoursHomeBy : he.request.stopHoursArriveBy)
      : which === "leave" ? he.request.stopHoursEstLeave : he.request.stopHoursEstArrive;
    const minutes = fixed ? fixed.at : which === "leave" ? point.leave : point.arrive;
    return (
      <HourChip
        label={label} minutes={minutes} fixed={!!fixed} flex={fixed?.flex} onClick={onClick} open={isOpen} testId={testId}
        ariaLabel={onClick ? tv("request.stopHoursEditAria", { place: nameOf(key) }) : undefined}
      />
    );
  }
  const editEnd = (end: "out" | "return") => (renderEndHours ? () => setEditingEnd(end) : undefined);
  function applyPicked(picked: PickedOption) {
    if (!addingPlace) return;
    const blockIndex = picked.leg === "out" ? picked.beforeIndex : picked.beforeIndex - 1;
    let hours = stopHours;
    for (const s of picked.shortened) {
      const [leg, pos] = s.key.split(":");
      const value = (leg === "out" ? outValues : hiddenReturn)[Number(pos) - 1];
      if (!value || (leg !== "out" && leg !== "return")) continue;
      const current = stopHoursOf(hours, leg, value);
      if (current.stay !== null) hours = withStopHours(hours, leg, value, { ...current, stay: Math.max(1, current.stay - s.minutes) });
    }
    if (hours !== stopHours) form.setValue("stopHours", hours, { shouldDirty: true });
    commit(insertStop(blocks, blockIndex, addingPlace));
    setAddingPlace(null);
  }
  const fixedCount = timing.points.filter((p) => p.fixed).length;
  const conflict = timing.schedule?.conflict ?? null;
  const pickerPlaces = picking && picking.kind === "origin" ? places : placesWithoutOrigin;

  return (
    <FieldSheet open={open} onOpenChange={close} title={he.request.stopsEditorTitle} testId="stops-sheet">
      {addingPlace && timing.schedule && timing.hops && timing.values ? (
        <div className="space-y-2">
          <AddStopOptions
            departmentId={timing.departmentId}
            values={timing.values}
            points={timing.points}
            hops={timing.hops}
            place={addingPlace}
            placeName={placeName(addingPlace, places)}
            nameOf={nameOf}
            defaultStart={timing.values.departTime ? timeToMinutes(timing.values.departTime) : 8 * 60}
            drive={timing.drive}
            onPick={applyPicked}
          />
          <button type="button" className="text-sm text-muted-foreground underline-offset-2 hover:underline" onClick={() => setAddingPlace(null)}>
            {he.request.stopBackToList}
          </button>
        </div>
      ) : editingEnd && renderEndHours ? (
        <div className="space-y-2" data-testid={`stops-end-hours-${editingEnd}`}>
          {renderEndHours(editingEnd)}
          <button type="button" className="text-sm text-muted-foreground underline-offset-2 hover:underline" onClick={() => setEditingEnd(null)}>
            {he.request.stopBackToList}
          </button>
        </div>
      ) : picking ? (
        <div className="space-y-2">
          <PlacePicker places={pickerPlaces} value={null} onPick={pick} placeholder={he.request.stopPlaceholder} />
          <button type="button" className="text-sm text-muted-foreground underline-offset-2 hover:underline" onClick={() => setPicking(null)}>
            {he.request.stopBackToList}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <div ref={listRef} className="grid grid-cols-[2rem_1.25rem_minmax(0,1fr)] gap-x-1" data-testid="stops-list">
            {(() => {
              const destinationAt = blocks.findIndex((b) => b.kind === "destination");
              const hot: Leg | null = drag ? legAt(blocks, drag.at) : null;
              const label = (leg: Leg, from: number, to: number) => (
                <div
                  key={`label-${leg}`}
                  className="flex items-center justify-center text-[11px] font-medium text-muted-foreground"
                  style={{ gridColumn: 1, gridRow: `${from} / ${to}` }}
                  data-testid={`stops-rail-${leg}`}
                >
                  {leg === "out" ? he.request.stopsLegOut : he.request.stopsLegReturn}
                </div>
              );
              // Each label spans both end rows of its leg (the line runs dot centre to dot centre),
              // so the two spans share the destination row.
              const labels = [label("out", 1, destinationAt + 2), ...(hasReturn ? [label("return", destinationAt + 1, blocks.length + 1)] : [])];
              return [...labels, ...blocks.map((block, index) => {
              const lastIndex = blocks.length - 1;
              const above: Leg | null = index === 0 ? null : index <= destinationAt ? "out" : "return";
              const below: Leg | null = index === lastIndex ? null : index < destinationAt ? "out" : "return";
              const line = (leg: Leg) => cn("w-0.5 flex-1", leg === "out" ? "bg-muted-foreground/30" : "bg-foreground", hot === leg && "w-1");
              return (
                <Fragment key={`${index}:${block.kind}`}>
                  <div className="flex flex-col items-center" style={{ gridColumn: 2, gridRow: index + 1 }} aria-hidden="true">
                    {above ? <div className={line(above)} /> : <div className="flex-1" />}
                    <span className={cn("my-0.5 shrink-0 rounded-full border-2", block.kind === "destination" ? "size-4 border-background bg-foreground ring-2 ring-foreground" : cn("size-2.5 bg-background", block.kind === "stop" ? "border-muted-foreground" : "border-primary"))} />
                    {below ? <div className={line(below)} /> : <div className="flex-1" />}
                  </div>
                  <div className="min-w-0 py-0.5" style={{ gridColumn: 3, gridRow: index + 1 }}>
                  <div
                    data-block-index={index}
                    className={cn("rounded-md border bg-background", drag && drag.at === index && drag.from !== index && "border-t-4 border-t-primary", drag?.from === index && "opacity-60")}
                  >
                    {block.kind === "stop" ? (
                      <div className="flex min-h-11 items-center gap-1 ps-1" data-testid="stop-block">
                        <button
                          type="button"
                          aria-label={he.request.stopDragHandle}
                          data-testid="stop-grip"
                          className="flex size-10 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground"
                          onPointerDown={(event) => {
                            event.currentTarget.setPointerCapture(event.pointerId);
                            setDrag({ from: index, at: index });
                          }}
                          onPointerMove={(event) => { if (drag?.from === index) setDrag({ from: index, at: dropIndexAt(event.clientY) }); }}
                          onPointerUp={(event) => {
                            if (drag?.from === index) commit(moveStop(blocks, index, dropIndexAt(event.clientY)));
                            setDrag(null);
                          }}
                          onPointerCancel={() => setDrag(null)}
                          onKeyDown={(event) => {
                            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                              event.preventDefault();
                              commit(nudgeStop(blocks, index, event.key === "ArrowUp" ? -1 : 1));
                            }
                          }}
                        >
                          <GripVertical className="size-4" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="min-h-11 flex-1 truncate text-start text-sm"
                          aria-label={`${he.request.stopChangePlace}: ${placeName(block.value, places)}`}
                          onClick={() => setPicking({ kind: "edit", index })}
                        >
                          {placeName(block.value, places)}
                        </button>
                        {(() => {
                          const sk = stopKey(index);
                          return sk ? chipFor(sk.key, "arrive", "stop-hour", () => setEditingHours(editingHours === index ? null : index), editingHours === index) : null;
                        })()}
                        <button
                          type="button"
                          aria-label={`${he.request.removeStop}: ${placeName(block.value, places)}`}
                          data-testid="stop-remove"
                          className="flex size-10 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
                          onClick={() => commit(removeBlock(blocks, index))}
                        >
                          <X className="size-4" aria-hidden="true" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1 pe-1">
                      <button
                        type="button"
                        className={`min-h-11 min-w-0 flex-1 truncate px-3 text-start text-sm font-medium rounded-md ${block.kind === "destination" ? "bg-accent" : "bg-primary/10"}`}
                        data-testid={`stop-block-${block.kind === "origin" ? "origin" : block.kind === "originEnd" ? "origin-end" : "destination"}`}
                        aria-label={tv("request.stopChangeFixed", { place: block.kind === "destination" ? destinationName || he.field.destination : originName })}
                        onClick={() => setPicking({ kind: block.kind === "destination" ? "destination" : "origin" })}
                      >
                        {block.kind === "destination" ? destinationName || he.field.destination : originName}
                      </button>
                      {/* REQ item 246: the ends' hours are the form's own times; REQ item 249: tapping one opens that
                          way's time editor here (sentence form). */}
                      {block.kind === "origin" ? chipFor("start", "leave", "end-hour-start", editEnd("out"))
                        : block.kind === "originEnd" ? chipFor("end", "arrive", "end-hour-end", editEnd("return"))
                        : (
                          <>
                            {chipFor("dest", "arrive", "end-hour-dest", editEnd("out"))}
                            {hasReturn ? chipFor("back", "leave", "end-hour-back", editEnd("return")) : null}
                          </>
                        )}
                      </div>
                    )}
                    {block.kind === "destination" && pointOf("dest") && hasReturn ? (
                      <div className="px-3 pb-1 text-xs text-muted-foreground">
                        {tv(pointOf("dest")!.stayWorkedOut ? "request.stopHoursStayWorkedOut" : "request.stopHoursStayGiven", { duration: durationLabel(pointOf("dest")!.stay) })}
                      </div>
                    ) : null}
                    {(() => {
                      const sk = stopKey(index);
                      const point = sk ? pointOf(sk.key) : undefined;
                      if (!sk) return null;
                      const fixed = fixedOf(sk.key);
                      return (
                        <div className="space-y-1 px-2 pb-1">
                          {point ? (
                            <div className="text-xs text-muted-foreground" data-testid="stop-stay">
                              {tv(point.stayWorkedOut ? "request.stopHoursStayWorkedOut" : "request.stopHoursStayGiven", { duration: durationLabel(point.stay) })}
                              {" · "}
                              {tv("request.stopHoursLeavesAt", { time: clock(point.leave) })}
                            </div>
                          ) : null}
                          {point && point.early > 0 ? (
                            <div className="w-fit rounded bg-green-100 px-1.5 text-xs text-green-900 dark:bg-green-900/40 dark:text-green-100">{tv("request.stopHoursEarly", { minutes: String(point.early) })}</div>
                          ) : null}
                          {point && fixed && point.flexUsed > 0 ? (
                            <div className="w-fit rounded bg-amber-100 px-1.5 text-xs text-amber-950 dark:bg-amber-900/40 dark:text-amber-100">
                              {tv("request.stopHoursFlexUsed", { time: clock(fixed.at + point.flexUsed), until: clock(fixed.at + fixed.flex) })}
                            </div>
                          ) : null}
                          {editingHours === index ? (
                            <StopHoursEditor
                              hours={stopHoursOf(stopHours, sk.leg, sk.value)}
                              shownMinutes={fixed ? fixed.at : point?.arrive ?? 8 * 60}
                              onCancel={() => setEditingHours(null)}
                              onApply={(hours) => {
                                form.setValue("stopHours", withStopHours(stopHours, sk.leg, sk.value, hours), { shouldDirty: true });
                                setEditingHours(null);
                              }}
                            />
                          ) : null}
                        </div>
                      );
                    })()}
                  </div>
                  </div>
                </Fragment>
              );
            })];
            })()}
          </div>
          <button
            type="button"
            className="min-h-11 text-sm text-primary disabled:opacity-50"
            data-testid="add-stop-here"
            disabled={addIndex === null}
            onClick={() => addIndex !== null && setPicking({ kind: "add", index: addIndex })}
          >
            {he.request.addStopHere}
          </button>
          {timing.schedule ? (
            <div className="space-y-1 rounded-md border bg-muted/30 p-2 text-xs" data-testid="stop-hours-summary">
              <p>{he.request.stopHoursLegend}</p>
              <p className="font-medium text-primary">
                {fixedCount === 0 ? he.request.stopHoursCountNone : fixedCount === 1 ? he.request.stopHoursCountOne : tv("request.stopHoursCountMany", { count: String(fixedCount) })}
              </p>
            </div>
          ) : null}
          {conflict ? (
            <p className="w-fit rounded bg-amber-100 px-1.5 text-sm font-medium text-amber-950 dark:bg-amber-900/40 dark:text-amber-100" data-testid="stop-hours-conflict">
              {tv("request.stopTight", { place: nameOf(conflict.key) })}
            </p>
          ) : null}
        </div>
      )}
    </FieldSheet>
  );
}
