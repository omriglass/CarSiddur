import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { he, tv } from "@/i18n/he";
import { cn } from "@/lib/utils";

import { keyMove, swipeMove, type GuideStep, type StepMove } from "../lib/guides";

/**
 * REQ item 259 (owner 2026-11-20): a guide opens one step per screen, big and readable ("שלב 2 מתוך 5"). Tap the step
 * for the next one, swipe back for the previous (RTL: the finger moving left goes back), buttons and dots too, arrow
 * keys on a computer; the last step ends with "סיום". A longer guide may be read as one list instead (toggle).
 */
export function GuideViewer({ title, steps, onDone }: { title: string; steps: readonly GuideStep[]; onDone: () => void }) {
  const [index, setIndex] = useState(0);
  const [asList, setAsList] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);
  const areaRef = useRef<HTMLDivElement>(null);
  const total = steps.length;
  const last = index >= total - 1;

  useEffect(() => { areaRef.current?.focus(); }, [asList]);

  const go = (move: StepMove) => setIndex((i) => (move === "next" ? Math.min(total - 1, i + 1) : Math.max(0, i - 1)));

  if (!total) return null;

  return (
    <div className="space-y-3" data-testid="guide-viewer">
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold" dir="auto">{title}</p>
        {total > 1 ? (
          <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => setAsList((v) => !v)} data-testid="guide-toggle-list">
            {asList ? he.carGuides.asSteps : he.carGuides.asList}
          </Button>
        ) : null}
      </div>

      {asList ? (
        <ol className="list-decimal space-y-2 ps-5 text-base" data-testid="guide-list">
          {steps.map((step, i) => <li key={i} className="whitespace-pre-line" dir="auto">{step.text}</li>)}
        </ol>
      ) : (
        <>
          <p className="text-xs text-muted-foreground" data-testid="guide-step-of">
            {tv("carGuides.stepOf", { n: String(index + 1), total: String(total) })}
          </p>
          <div
            ref={areaRef}
            role="button"
            tabIndex={0}
            aria-label={last ? he.carGuides.done : he.carGuides.next}
            className="flex min-h-48 cursor-pointer select-none items-center rounded-xl border bg-card p-5 text-xl leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{ touchAction: "pan-y" }}
            data-testid="guide-step"
            onPointerDown={(e) => { start.current = { x: e.clientX, y: e.clientY }; swiped.current = false; }}
            onPointerUp={(e) => {
              if (!start.current) return;
              const move = swipeMove(e.clientX - start.current.x, e.clientY - start.current.y);
              start.current = null;
              if (move) { swiped.current = true; go(move); }
            }}
            onClick={() => {
              if (swiped.current) { swiped.current = false; return; }
              if (!last) go("next");
            }}
            onKeyDown={(e) => {
              const move = keyMove(e.key);
              if (!move) return;
              e.preventDefault();
              if (move === "next" && last) onDone();
              else go(move);
            }}
          >
            <p className="w-full whitespace-pre-line" dir="auto">{steps[index]?.text}</p>
          </div>
          {index === 0 && total > 1 ? <p className="text-center text-xs text-muted-foreground">{he.carGuides.tapHint}</p> : null}
          {total > 1 ? (
            <div className="flex justify-center gap-1.5" aria-hidden="true">
              {steps.map((_, i) => (
                <span key={i} className={cn("size-2 rounded-full", i === index ? "bg-primary" : "bg-muted-foreground/30")} />
              ))}
            </div>
          ) : null}
        </>
      )}

      <div className="flex gap-2">
        {!asList && total > 1 ? (
          <Button type="button" variant="outline" className="flex-1" disabled={index === 0} onClick={() => go("prev")} data-testid="guide-prev">
            {he.carGuides.prev}
          </Button>
        ) : null}
        {asList || last ? (
          <Button type="button" className="flex-1" onClick={onDone} data-testid="guide-done">{he.carGuides.done}</Button>
        ) : (
          <Button type="button" className="flex-1" onClick={() => go("next")} data-testid="guide-next">{he.carGuides.next}</Button>
        )}
      </div>
    </div>
  );
}
