import { todayInJerusalem } from "@/components/DateField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { he } from "@/i18n/he";

import { STATS_PRESET_KEYS, computePresetRange, type StatsDateRange, type StatsPresetKey } from "../presets";

interface StatsDateRangePickerProps {
  value: StatsDateRange;
  onChange: (range: StatsDateRange) => void;
}

/** Date-range selector: two native date inputs + three quick presets (UX_FLOWS.md §5.12). */
export function StatsDateRangePicker({ value, onChange }: StatsDateRangePickerProps) {
  const today = todayInJerusalem();

  function applyPreset(preset: StatsPresetKey) {
    onChange(computePresetRange(preset, today));
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="stats-date-from">{he.stats.dateFrom}</Label>
          <Input
            id="stats-date-from"
            type="date"
            dir="ltr"
            value={value.from}
            max={value.to}
            onChange={(event) => onChange({ ...value, from: event.target.value })}
            className="min-h-11 w-40"
            data-testid="stats-date-from"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="stats-date-to">{he.stats.dateTo}</Label>
          <Input
            id="stats-date-to"
            type="date"
            dir="ltr"
            value={value.to}
            min={value.from}
            max={today}
            onChange={(event) => onChange({ ...value, to: event.target.value })}
            className="min-h-11 w-40"
            data-testid="stats-date-to"
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {STATS_PRESET_KEYS.map((preset) => (
          <Button
            key={preset}
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11"
            onClick={() => applyPreset(preset)}
            data-testid={`stats-preset-${preset}`}
          >
            {he.stats.presets[preset]}
          </Button>
        ))}
      </div>
    </div>
  );
}
