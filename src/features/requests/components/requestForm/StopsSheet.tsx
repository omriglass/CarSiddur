// REQUIREMENTS §13.93 "Multi-stop rides" / UX_FLOWS "Stops, built 2026-11-08" (TODO ST1 rework):
// the stops editor, shared by the classic and the sentence form. One sheet with ONE ordered
// list: origin (fixed) -> out stops -> destination (fixed) -> return stops -> origin (fixed; the
// return part only with a return leg). Tap origin/destination to change them, drag a stop by
// its grip (pointer events; arrow keys on the grip) to reorder or move it across the destination
// into the other leg, "+ הוספת עצירה" between blocks adds one there. The position decides the leg
// (pure logic: stopsModel.ts). The picker is the inline `PlacePicker` — no second floating layer.
import { GripVertical, X } from "lucide-react";
import { Fragment, useRef, useState } from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";

import type { DestinationValue } from "@/components/DestinationCombobox";
import { he, tv } from "@/i18n/he";
import { cn } from "@/lib/utils";

import type { RequestFormValues } from "../../schema";
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
}

export function StopsSheet({ form, places, hasReturn, open, onOpenChange }: StopsSheetProps) {
  const [origin, destination, outStops, returnStops] = useWatch({
    control: form.control,
    name: ["origin", "destination", "outStops", "returnStops"],
  }) as [DestinationValue | null, DestinationValue | null, DestinationValue[] | undefined, DestinationValue[] | undefined];
  const hiddenReturn = returnStops ?? [];
  const blocks = toBlocks({ outStops: outStops ?? [], returnStops: hiddenReturn }, hasReturn);
  const [picking, setPicking] = useState<Picking>(null);
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
    if (!next) { setPicking(null); setDrag(null); }
    onOpenChange(next);
  }

  function pick(value: DestinationValue) {
    if (!picking) return;
    if (picking.kind === "origin" || picking.kind === "destination") {
      form.setValue(picking.kind, value, { shouldDirty: true, shouldValidate: true });
    } else if (picking.kind === "add") {
      commit(insertStop(blocks, picking.index, value));
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
  const pickerPlaces = picking && picking.kind === "origin" ? places : placesWithoutOrigin;

  return (
    <FieldSheet open={open} onOpenChange={close} title={he.request.stopsEditorTitle} testId="stops-sheet">
      {picking ? (
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
                      <button
                        type="button"
                        className={`min-h-11 w-full truncate px-3 text-start text-sm font-medium rounded-md ${block.kind === "destination" ? "bg-accent" : "bg-primary/10"}`}
                        data-testid={`stop-block-${block.kind === "origin" ? "origin" : block.kind === "originEnd" ? "origin-end" : "destination"}`}
                        aria-label={tv("request.stopChangeFixed", { place: block.kind === "destination" ? destinationName || he.field.destination : originName })}
                        onClick={() => setPicking({ kind: block.kind === "destination" ? "destination" : "origin" })}
                      >
                        {block.kind === "destination" ? destinationName || he.field.destination : originName}
                      </button>
                    )}
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
        </div>
      )}
    </FieldSheet>
  );
}
