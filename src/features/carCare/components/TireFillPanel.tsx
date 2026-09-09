import { Textarea } from "@/components/ui/textarea";
import { he } from "@/i18n/he";
import { cn } from "@/lib/utils";

import { cycleTireState, TIRE_POSITIONS, type TirePosition, type TireState, type TireStates } from "../schema";

const STATE_CLASSES: Record<TireState, string> = {
  ok: "border-available bg-available/20 text-available",
  low: "border-maintenance bg-maintenance/20 text-maintenance",
  very_low: "border-destructive bg-destructive/20 text-destructive",
};

const POSITION_STYLE: Record<TirePosition, string> = {
  front_left: "start-2 top-4",
  front_right: "end-2 top-4",
  rear_left: "start-2 bottom-16",
  rear_right: "end-2 bottom-16",
  spare: "inset-x-0 bottom-2 mx-auto",
};

const TIRE_STATE_LABEL: Record<TireState, string> = {
  ok: he.carCare.tireLegendOk,
  low: he.carCare.tireLegendLow,
  very_low: he.carCare.tireLegendVeryLow,
};

interface TireButtonProps {
  position: TirePosition;
  state: TireState;
  onCycle: (position: TirePosition) => void;
}

function TireButton({ position, state, onCycle }: TireButtonProps) {
  return (
    <button
      type="button"
      aria-label={`${he.carCare.tirePosition[position]} — ${TIRE_STATE_LABEL[state]}`}
      data-testid={`tire-${position}`}
      data-tire={position}
      data-tire-state={state}
      onClick={() => onCycle(position)}
      className={cn(
        "absolute flex size-11 items-center justify-center rounded-full border-2 text-[10px] font-bold transition-smooth",
        STATE_CLASSES[state],
        POSITION_STYLE[position],
      )}
    >
      {he.carCare.tirePosition[position].slice(0, 2)}
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
 * Inline SVG top-down car schematic (REQUIREMENTS §6.6, §13.72): four wheel
 * buttons at the corners plus the spare in the trunk area, each cycling
 * ok → low → very_low → ok on tap. `TIRE_POSITIONS` order drives the
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
          <rect x="40" y="20" width="120" height="260" rx="28" className="fill-muted stroke-border" strokeWidth={2} />
          <rect x="72" y="42" width="56" height="46" rx="8" className="fill-background/70" />
          <rect x="78" y="220" width="44" height="34" rx="6" className="fill-background/70" />
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
