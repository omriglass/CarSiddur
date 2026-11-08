import { Check } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";

import { useTheme } from "@/hooks/useTheme";
import { he } from "@/i18n/he";
import { cn } from "@/lib/utils";
import { CUSTOM_THEME_ID, THEMES } from "@/themes/registry";
import type { CustomTheme } from "@/themes/types";
import { CustomThemeEditor } from "./CustomThemeEditor";

interface Option {
  id: string;
  name: string;
  swatch: readonly [string, string, string];
  lightOnly: boolean;
}

function customSwatch(custom: CustomTheme): readonly [string, string, string] {
  return [custom.light.background, custom.light.primary, custom.light.card];
}

/** Profile → מראה → "ערכת נושא": swatch cards (a radiogroup) and, for the custom theme, the inline editor. */
export function ThemePicker() {
  const { themeId, setThemeId, custom, setCustom } = useTheme();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const options: Option[] = [
    ...THEMES.map((theme) => ({
      id: theme.id,
      name: he.themes.names[theme.nameKey],
      swatch: theme.swatch,
      lightOnly: theme.light !== "neutral" && theme.dark === "neutral",
    })),
    { id: CUSTOM_THEME_ID, name: he.themes.names.custom, swatch: customSwatch(custom), lightOnly: false },
  ];

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    // RTL: the inline-start arrow (right) goes to the previous card.
    const step = event.key === "ArrowLeft" || event.key === "ArrowDown" ? 1 : event.key === "ArrowRight" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    refs.current[next]?.focus();
    const option = options[next];
    if (option) setThemeId(option.id);
  };

  return (
    <div className="space-y-3">
      <div
        role="radiogroup"
        aria-label={he.themes.themeLabel}
        className="grid grid-cols-2 gap-2 sm:grid-cols-3"
      >
        {options.map((option, index) => {
          const selected = option.id === themeId;
          return (
            <button
              key={option.id}
              ref={(el) => {
                refs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              data-testid={`theme-option-${option.id}`}
              onClick={() => setThemeId(option.id)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={cn(
                "relative flex min-h-11 flex-col gap-2 rounded-lg border bg-card p-2 text-start text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected ? "border-primary ring-2 ring-primary" : "border-border hover:bg-accent/40",
              )}
            >
              <span
                aria-hidden="true"
                className="relative flex h-10 items-center gap-2 overflow-hidden rounded-md border border-black/10 px-2"
                style={{ backgroundColor: option.swatch[0] }}
              >
                <span className="h-4 w-10 rounded-full" style={{ backgroundColor: option.swatch[1] }} />
                <span className="h-3 w-3 rounded-full" style={{ backgroundColor: option.swatch[2] }} />
              </span>
              <span className="flex items-center justify-between gap-1">
                <span className="font-medium">{option.name}</span>
                {selected && <Check className="h-4 w-4 text-primary" aria-hidden="true" />}
              </span>
              {option.lightOnly && (
                <span className="text-xs text-muted-foreground">{he.themes.darkNote}</span>
              )}
            </button>
          );
        })}
      </div>
      {themeId === CUSTOM_THEME_ID && <CustomThemeEditor custom={custom} onChange={setCustom} />}
    </div>
  );
}
