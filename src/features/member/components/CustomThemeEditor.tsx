import type { CSSProperties } from "react";

import { Button } from "@/components/ui/button";
import { he } from "@/i18n/he";
import { DEFAULT_CUSTOM_THEME } from "@/themes/apply";
import { deriveTokens } from "@/themes/derive";
import type { CustomTheme, ThemeMode, ThemeSeeds } from "@/themes/types";

/** The three colours a member picks per mode (REQ §13.196 a). */
const FIELDS = ["background", "card", "primary"] as const;
type Field = (typeof FIELDS)[number];

interface Props {
  custom: CustomTheme;
  onChange: (next: CustomTheme) => void;
}

/** Inline editor for "מותאם אישית": light and dark colours, a readability note and a live preview per mode. */
export function CustomThemeEditor({ custom, onChange }: Props) {
  const copy = he.themes.custom;
  const set = (mode: ThemeMode, field: Field, value: string) =>
    onChange({ ...custom, [mode]: { ...custom[mode], [field]: value } });

  return (
    <div className="space-y-4" data-testid="custom-theme-editor">
      {(["light", "dark"] as const).map((mode) => (
        <ModeSection
          key={mode}
          mode={mode}
          title={mode === "light" ? copy.lightTitle : copy.darkTitle}
          seeds={custom[mode]}
          onField={(field, value) => set(mode, field, value)}
        />
      ))}
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        data-testid="custom-theme-reset"
        onClick={() => onChange(DEFAULT_CUSTOM_THEME)}
      >
        {copy.reset}
      </Button>
    </div>
  );
}

function ModeSection({
  mode,
  title,
  seeds,
  onField,
}: {
  mode: ThemeMode;
  title: string;
  seeds: ThemeSeeds;
  onField: (field: Field, value: string) => void;
}) {
  const copy = he.themes.custom;
  const { tokens, adjusted, effective } = deriveTokens(seeds);
  return (
    <section className="space-y-2 rounded-lg border p-3" data-testid={`custom-theme-${mode}`}>
      <h4 className="text-sm font-semibold">{title}</h4>
      <div className="grid gap-2">
        {FIELDS.map((field) => {
          const id = `custom-theme-${mode}-${field}`;
          return (
            <div key={field} className="space-y-1">
              <div className="flex min-h-11 items-center gap-3">
                <input
                  id={id}
                  type="color"
                  value={seeds[field]}
                  onChange={(e) => onField(field, e.target.value)}
                  className="h-11 w-11 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5"
                  data-testid={id}
                />
                <label htmlFor={id} className="flex-1 text-sm">
                  {copy[field]}
                </label>
                <span dir="ltr" className="text-xs text-muted-foreground">
                  {seeds[field]}
                </span>
              </div>
              {adjusted.includes(field) && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid={`${id}-adjusted`}>
                  <span>{copy.adjusted}</span>
                  <span
                    role="img"
                    aria-label={copy.effectiveAria}
                    className="inline-block h-4 w-4 rounded-full border"
                    style={{ backgroundColor: effective[field] }}
                  />
                  <span dir="ltr">{effective[field]}</span>
                </p>
              )}
            </div>
          );
        })}
      </div>
      <div
        aria-hidden="true"
        className="space-y-1.5 rounded-lg border border-border bg-background p-3 text-foreground"
        style={Object.fromEntries(Object.entries(tokens).map(([k, v]) => [`--${k}`, v])) as CSSProperties}
        data-testid={`custom-theme-${mode}-preview`}
      >
        <div className="space-y-1.5 rounded-md border border-border bg-card p-3 text-card-foreground">
          <p className="text-sm font-semibold">{copy.previewHeading}</p>
          <p className="text-sm">{copy.previewBody}</p>
          <p className="text-xs text-muted-foreground">{copy.previewMuted}</p>
          <div className="flex items-center gap-2 pt-1">
            <span className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground">
              {copy.previewButton}
            </span>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
              {copy.previewBadge}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
