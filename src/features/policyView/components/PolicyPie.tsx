import type { ReactNode } from "react";

import { he, tv } from "@/i18n/he";
import { cn } from "@/lib/utils";

import { ruleColor, ruleName, type RuleSlice } from "../ruleExplain";

const SIZE = 220;
const STROKE = 46;
/** Room around the ring for the pulled-out slice. */
const PAD = 12;
const RADIUS = (SIZE - STROKE) / 2 - PAD;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** 2px surface gap between neighbouring slices (dataviz mark spec). */
const GAP = 2;
/** How far the chosen slice moves out from the centre. */
const PULL = 9;

function percentOf(slice: RuleSlice): string {
  return String(Math.round(slice.fraction * 100));
}

interface PolicyPieProps {
  slices: RuleSlice[];
  selected: string | null;
  onSelect: (type: string | null) => void;
  /** Shown right under the ring, above the legend — on a phone the chosen rule's calculation stays in view. */
  details?: ReactNode;
}

/**
 * "הצג מדיניות" pie (REQ §13.133): one ring slice per rule, sized by its weight, in the fixed rule
 * color. Tapping a slice (or its legend row — the keyboard path) selects it: it moves out a little and
 * the others fade; tapping it again clears the choice. Inline SVG `stroke-dasharray` arcs like the
 * stats donut (`RideTypePie`); the legend always names every slice with its share, so color is never
 * the only cue (three light-mode hues sit below 3:1 against the card).
 */
export function PolicyPie({ slices, selected, onSelect, details }: PolicyPieProps) {
  const chosen = slices.find((slice) => slice.rule.type === selected) ?? null;
  const gap = slices.length > 1 ? GAP : 0;
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} className="-rotate-90" role="img" aria-label={he.policyView.pieHint}>
          {slices.map((slice) => {
            const length = Math.max(0, slice.fraction * CIRCUMFERENCE - gap);
            const mid = ((slice.start + slice.end) / 2) * 2 * Math.PI;
            const isChosen = slice.rule.type === selected;
            const dx = isChosen ? Math.cos(mid) * PULL : 0;
            const dy = isChosen ? Math.sin(mid) * PULL : 0;
            return (
              <circle
                key={slice.rule.type}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                stroke={ruleColor(slice.rule.type)}
                strokeWidth={isChosen ? STROKE + 6 : STROKE}
                strokeDasharray={`${length} ${CIRCUMFERENCE - length}`}
                strokeDashoffset={-(slice.start * CIRCUMFERENCE + gap / 2)}
                transform={`translate(${dx} ${dy})`}
                className={cn("cursor-pointer transition-all duration-200", chosen && !isChosen && "opacity-40")}
                data-testid={`policy-slice-${slice.rule.type}`}
                data-selected={isChosen || undefined}
                onClick={() => onSelect(isChosen ? null : slice.rule.type)}
              >
                <title>{`${ruleName(slice.rule.type)} — ${tv("policyView.share", { percent: percentOf(slice) })}`}</title>
              </circle>
            );
          })}
        </svg>
        {chosen ? (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            <span className="text-2xl font-semibold text-foreground" dir="ltr">{tv("policyView.share", { percent: percentOf(chosen) })}</span>
            <span className="max-w-24 text-xs text-muted-foreground">{ruleName(chosen.rule.type)}</span>
          </div>
        ) : null}
      </div>
      {details ? <div className="w-full">{details}</div> : null}
      <ul className="w-full space-y-1">
        {slices.map((slice) => {
          const isChosen = slice.rule.type === selected;
          return (
            <li key={slice.rule.type}>
              <button
                type="button"
                className={cn(
                  "flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-start text-sm hover:bg-accent",
                  isChosen && "bg-accent font-semibold",
                  chosen && !isChosen && "text-muted-foreground",
                )}
                aria-pressed={isChosen}
                onClick={() => onSelect(isChosen ? null : slice.rule.type)}
                data-testid={`policy-legend-${slice.rule.type}`}
              >
                <span className="size-3 shrink-0 rounded-full" style={{ background: ruleColor(slice.rule.type) }} aria-hidden="true" />
                <span className="flex-1">{ruleName(slice.rule.type)}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground" dir="ltr">{tv("policyView.share", { percent: percentOf(slice) })}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
