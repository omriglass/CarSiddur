import { Textarea } from "@/components/ui/textarea";
import { he } from "@/i18n/he";
import { cn } from "@/lib/utils";

import { cycleTireState, TIRE_POSITIONS, type TirePosition, type TireState, type TireStates } from "../schema";

const STATE_CLASSES: Record<TireState, string> = {
  unchecked: "border-dashed border-muted-foreground/50 bg-muted text-muted-foreground opacity-70",
  ok: "border-available bg-available/20 text-available",
  low: "border-maintenance bg-maintenance/20 text-maintenance",
  very_low: "border-destructive bg-destructive/20 text-destructive",
};

const POSITION_STYLE: Record<TirePosition, string> = {
  // physical left/right on purpose: the drawing is a fixed top view (front up, kerb on the right) and does not mirror in RTL
  front_left: "left-[13%] top-[7%]",
  front_right: "right-[13%] top-[7%]",
  rear_left: "left-[13%] bottom-[12%]",
  rear_right: "right-[13%] bottom-[12%]",
  spare: "inset-x-0 bottom-[11%] mx-auto",
};

const TIRE_STATE_LABEL: Record<TireState, string> = {
  unchecked: he.carCare.tireLegendUnchecked,
  ok: he.carCare.tireLegendOk,
  low: he.carCare.tireLegendLow,
  very_low: he.carCare.tireLegendVeryLow,
};

const TREAD_ROWS = [6, 14, 22, 30, 38, 46] as const;

/** One tire seen from above, drawn in the button's text colour: tinted body, chunky chevron tread, lugs on both shoulders. The spare is a round tire with a lugged ring. */
function TireDrawing({ spare, unchecked }: { spare: boolean; unchecked: boolean }) {
  const dash = unchecked ? "3 2" : undefined;
  if (spare) {
    return (
      <svg viewBox="0 0 44 44" className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
        <circle cx="22" cy="22" r="19" fill="currentColor" fillOpacity={0.15} stroke="currentColor" strokeWidth={1.5} strokeDasharray={dash} />
        <circle cx="22" cy="22" r="16.5" fill="none" stroke="currentColor" strokeWidth={5} strokeDasharray="5 3" strokeOpacity={0.8} />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 44 56" className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
      <rect x="5" y="1" width="34" height="54" rx="8" fill="currentColor" fillOpacity={0.15} stroke="currentColor" strokeWidth={1.5} strokeDasharray={dash} />
      {TREAD_ROWS.map((y) => (
        <g key={y}>
          <rect x="1.5" y={y} width="4.5" height="5" rx="1" fill="currentColor" />
          <rect x="38" y={y} width="4.5" height="5" rx="1" fill="currentColor" />
          <polyline points={`8,${y} 22,${y + 5} 36,${y}`} fill="none" stroke="currentColor" strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" strokeOpacity={0.75} />
        </g>
      ))}
    </svg>
  );
}

interface TireButtonProps {
  position: TirePosition;
  state: TireState;
  onCycle: (position: TirePosition) => void;
}

function TireButton({ position, state, onCycle }: TireButtonProps) {
  const isSpare = position === "spare";
  return (
    <button
      type="button"
      aria-label={`${he.carCare.tirePosition[position]} — ${TIRE_STATE_LABEL[state]}`}
      data-testid={`tire-${position}`}
      data-tire={position}
      data-tire-state={state}
      onClick={() => onCycle(position)}
      className={cn(
        "absolute flex items-center justify-center text-[10px] font-bold transition-smooth",
        isSpare ? "size-11" : "h-14 w-11",
        STATE_CLASSES[state],
        // the tire drawing carries the outline and tint; only colour and opacity come from the state
        "border-0 bg-transparent",
        POSITION_STYLE[position],
      )}
    >
      <TireDrawing spare={isSpare} unchecked={state === "unchecked"} />
      <span className="relative line-clamp-2 w-10 max-w-full overflow-hidden break-words rounded bg-card/90 px-0.5 text-center text-[9px] leading-tight">
        {he.carCare.tirePosition[position]}
      </span>
    </button>
  );
}

interface TireFillPanelProps {
  value: TireStates;
  onChange: (next: TireStates) => void;
  note: string;
  onNoteChange: (note: string) => void;
}

/**
 * Inline SVG top-down car schematic (REQUIREMENTS §6.6, §13.72, TODO CG1): a
 * symbolic body (narrow bonnet and boot, wider cabin, windscreen, rear window,
 * roof, mirrors) between a kerb and a dashed lane marking, drawn with theme
 * tokens only. Four tread-lined tire buttons at the wheels plus the round spare
 * in the boot area, each cycling
 * unchecked → ok → low → very_low → unchecked on tap. `TIRE_POSITIONS` order drives the
 * component test's payload-shape assertion.
 */
export function TireFillPanel({ value, onChange, note, onNoteChange }: TireFillPanelProps) {
  function cycle(position: TirePosition) {
    onChange({ ...value, [position]: cycleTireState(value[position]) });
  }

  return (
    <div className="space-y-4">
      <div className="relative mx-auto aspect-[2/3] max-w-[220px]">
        <svg viewBox="0 0 200 300" className="absolute inset-0 h-full w-full" aria-hidden="true">
          {/* road (SVG x is not mirrored by RTL): kerb of alternating blue and white stones on the right, dashed lane marking on the left */}
          <rect x="186" y="0.00" width="14" height="33.34" className="fill-primary/35 stroke-border" strokeWidth={1} />
          <rect x="186" y="33.33" width="14" height="33.34" className="fill-card stroke-border" strokeWidth={1} />
          <rect x="186" y="66.67" width="14" height="33.34" className="fill-primary/35 stroke-border" strokeWidth={1} />
          <rect x="186" y="100.00" width="14" height="33.34" className="fill-card stroke-border" strokeWidth={1} />
          <rect x="186" y="133.33" width="14" height="33.34" className="fill-primary/35 stroke-border" strokeWidth={1} />
          <rect x="186" y="166.67" width="14" height="33.34" className="fill-card stroke-border" strokeWidth={1} />
          <rect x="186" y="200.00" width="14" height="33.34" className="fill-primary/35 stroke-border" strokeWidth={1} />
          <rect x="186" y="233.33" width="14" height="33.34" className="fill-card stroke-border" strokeWidth={1} />
          <rect x="186" y="266.67" width="14" height="33.34" className="fill-primary/35 stroke-border" strokeWidth={1} />
          <line x1="10" y1="0" x2="10" y2="300" className="stroke-muted-foreground/50" strokeWidth={3} strokeDasharray="22 14" />
          {/* body: narrow bonnet and boot, wider cabin */}
          <path
            d="M70 14 H130 Q142 14 142 28 L144 76 Q150 84 150 96 V272 Q150 286 136 286 H64 Q50 286 50 272 V96 Q50 84 56 76 L58 28 Q58 14 70 14 Z"
            className="fill-muted stroke-muted-foreground/60"
            strokeWidth={2}
          />
          <line x1="100" y1="22" x2="100" y2="68" className="stroke-border" strokeWidth={1.5} />
          {/* headlights */}
          <rect x="64" y="17" width="16" height="7" rx="3" className="fill-background stroke-muted-foreground/60" />
          <rect x="120" y="17" width="16" height="7" rx="3" className="fill-background stroke-muted-foreground/60" />
          {/* side mirrors */}
          <rect x="38" y="76" width="13" height="9" rx="3" className="fill-muted stroke-muted-foreground/60" strokeWidth={1.5} />
          <rect x="149" y="76" width="13" height="9" rx="3" className="fill-muted stroke-muted-foreground/60" strokeWidth={1.5} />
          {/* windscreen, roof, rear window */}
          <path d="M58 82 L142 82 L134 130 H66 Z" className="fill-background stroke-muted-foreground/60" strokeWidth={1.5} />
          <rect x="62" y="134" width="76" height="52" rx="8" className="fill-card stroke-border" strokeWidth={1.5} />
          <path d="M68 190 H132 L140 218 H60 Z" className="fill-background stroke-muted-foreground/60" strokeWidth={1.5} />
          {/* boot lid */}
          <rect x="60" y="228" width="80" height="48" rx="6" className="fill-background/50 stroke-border" strokeWidth={1.5} />
        </svg>
        {TIRE_POSITIONS.map((position) => (
          <TireButton key={position} position={position} state={value[position]} onCycle={cycle} />
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-3 text-xs text-muted-foreground">
        {(Object.keys(TIRE_STATE_LABEL) as TireState[]).map((state) => (
          <span key={state} className="flex items-center gap-1">
            <span className={cn("size-3 rounded-full border-2", STATE_CLASSES[state])} aria-hidden="true" />
            {TIRE_STATE_LABEL[state]}
          </span>
        ))}
      </div>

      <label className="flex flex-col gap-1 text-sm">
        {he.carCare.tireNoteLabel}
        <Textarea
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
        />
      </label>
    </div>
  );
}
