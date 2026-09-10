import { useState } from "react";

import { todayInJerusalem } from "@/components/DateField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateDMY } from "@/features/stats/format";
import { he, tv } from "@/i18n/he";

import { STATS_PRESET_KEYS, computePresetRange, type StatsDateRange, type StatsPresetKey } from "../presets";

interface StatsDateRangePickerProps {
  value: StatsDateRange;
  onChange: (range: StatsDateRange) => void;
  /**
   * Earliest date with data for the department (`department_stats`'s `earliest`,
   * owner feedback UX_FLOWS.md §5.12); `undefined` while unknown (first load),
   * `null` when the RPC couldn't determine one. Both mean "don't clamp yet".
   */
  earliest?: string | null;
}

type ClampHint = "from" | "to" | null;

/**
 * Date-range selector: two native date inputs + three quick presets
 * (UX_FLOWS.md §5.12). Neither bound may go before the department's first
 * data (`earliest`) nor after today — enforced here regardless of the native
 * `min`/`max` attributes, which some browsers don't strictly honor while typing.
 */
export function StatsDateRangePicker({ value, onChange, earliest }: StatsDateRangePickerProps) {
  const today = todayInJerusalem();
  const [hint, setHint] = useState<ClampHint>(null);

  function applyPreset(preset: StatsPresetKey) {
    setHint(null);
    onChange(computePresetRange(preset, today, earliest));
  }

  function handleFromChange(nextFrom: string) {
    if (earliest && nextFrom < earliest) {
      setHint("from");
      onChange({ ...value, from: earliest });
      return;
    }
    setHint(null);
    onChange({ ...value, from: nextFrom });
  }

  function handleToChange(nextTo: string) {
    if (nextTo > today) {
      setHint("to");
      onChange({ ...value, to: today });
      return;
    }
    setHint(null);
    onChange({ ...value, to: nextTo });
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
            min={earliest ?? undefined}
            max={value.to}
            onChange={(event) => handleFromChange(event.target.value)}
            className="min-h-11 w-40"
            data-testid="stats-date-from"
          />
          {hint === "from" ? (
            <p className="text-xs text-muted-foreground" data-testid="stats-date-from-hint">
              {tv("stats.clampedToEarliest", { date: earliest ? formatDateDMY(earliest) : "" })}
            </p>
          ) : null}
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
            onChange={(event) => handleToChange(event.target.value)}
            className="min-h-11 w-40"
            data-testid="stats-date-to"
          />
          {hint === "to" ? (
            <p className="text-xs text-muted-foreground" data-testid="stats-date-to-hint">
              {he.stats.clampedToToday}
            </p>
          ) : null}
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
