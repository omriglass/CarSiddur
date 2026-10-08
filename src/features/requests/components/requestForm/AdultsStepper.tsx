// R9M1: the "+ מבוגר/ת" stepper — adults travelling without a name (−/count/+), shared by the
// classic passengers block and the sentence layout's who sheet.
import { Minus, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";

export const MAX_EXTRA_ADULTS = 7;

interface AdultsStepperProps {
  value: number;
  onChange: (next: number) => void;
  moreLabel: string;
  lessLabel: string;
  testId?: string;
  /** Upper bound (default 7: `MAX_EXTRA_ADULTS`). */
  max?: number;
}

export function AdultsStepper({ value, onChange, moreLabel, lessLabel, testId, max = MAX_EXTRA_ADULTS }: AdultsStepperProps) {
  return (
    <div className="inline-flex items-center gap-2" data-testid={testId}>
      <Button type="button" variant="outline" size="icon" className="size-10 rounded-full" aria-label={lessLabel} disabled={value <= 0} onClick={() => onChange(Math.max(0, value - 1))}>
        <Minus className="size-4" aria-hidden="true" />
      </Button>
      <span className="min-w-6 text-center text-base font-medium tabular-nums" dir="ltr" aria-live="polite" data-testid={testId ? `${testId}-count` : undefined}>{value}</span>
      <Button type="button" variant="outline" size="icon" className="size-10 rounded-full" aria-label={moreLabel} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>
        <Plus className="size-4" aria-hidden="true" />
      </Button>
    </div>
  );
}
