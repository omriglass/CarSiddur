import { useEffect, useRef, useState, type CSSProperties } from "react";
import { HexColorInput, HexColorPicker } from "react-colorful";

import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { he, tv } from "@/i18n/he";
import { DEFAULT_CUSTOM_THEME } from "@/themes/apply";
import { deriveTokens } from "@/themes/derive";
import type { CustomTheme, ThemeMode, ThemeSeeds } from "@/themes/types";

/** The three colours a member picks per mode (REQ §13.196 a). */
const FIELDS = ["background", "card", "primary"] as const;
type Field = (typeof FIELDS)[number];

/** Suggested swatches per role and mode (seeds; readability is adjusted by deriveTokens). */
const SWATCHES: Record<ThemeMode, Record<Field, readonly string[]>> = {
  light: {
    background: ["#ffffff", "#f8fafc", "#f5f5f4", "#fef9ef", "#fdf2f8", "#f0fdf4", "#eff6ff", "#f5f3ff", "#ecfeff", "#fff7ed"],
    card: ["#ffffff", "#f1f5f9", "#fafaf9", "#fffbeb", "#fce7f3", "#dcfce7", "#dbeafe", "#ede9fe", "#cffafe", "#ffedd5"],
    primary: ["#2563eb", "#7c3aed", "#db2777", "#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#0d9488", "#0891b2", "#334155"],
  },
  dark: {
    background: ["#000000", "#0a0a0a", "#0f172a", "#111827", "#1c1917", "#0c1a14", "#1a1033", "#1f1020", "#0b1f2a", "#1b1b1f"],
    card: ["#111111", "#171717", "#1e293b", "#1f2937", "#292524", "#14281f", "#261a47", "#2d1a2e", "#12303f", "#27272a"],
    primary: ["#60a5fa", "#a78bfa", "#f472b6", "#f87171", "#fb923c", "#facc15", "#4ade80", "#2dd4bf", "#22d3ee", "#e2e8f0"],
  },
};

interface Props {
  custom: CustomTheme;
  onChange: (next: CustomTheme) => void;
}

/** Inline editor for "מותאם אישית": light and dark colours, a readability note and a live preview per mode. */
export function CustomThemeEditor({ custom, onChange }: Props) {
  const copy = he.themes.custom;
  // The editor keeps its own live copy so the preview follows every pointer move, while the (storing,
  // re-applying) onChange is throttled to about once per 150 ms with a trailing call.
  const [draft, setDraft] = useState(custom);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<CustomTheme | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pending.current) onChangeRef.current(pending.current);
    pending.current = null;
  };
  useEffect(() => flush, []);

  const set = (mode: ThemeMode, field: Field, value: string, immediate: boolean) => {
    const next = { ...draft, [mode]: { ...draft[mode], [field]: value } };
    setDraft(next);
    pending.current = next;
    if (immediate) flush();
    else if (!timer.current) timer.current = setTimeout(flush, 150);
  };

  return (
    <div className="space-y-4" data-testid="custom-theme-editor">
      {(["light", "dark"] as const).map((mode) => (
        <ModeSection
          key={mode}
          mode={mode}
          title={mode === "light" ? copy.lightTitle : copy.darkTitle}
          seeds={draft[mode]}
          onField={(field, value, immediate) => set(mode, field, value, immediate)}
        />
      ))}
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        data-testid="custom-theme-reset"
        onClick={() => {
          pending.current = null;
          setDraft(DEFAULT_CUSTOM_THEME);
          onChange(DEFAULT_CUSTOM_THEME);
        }}
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
  onField: (field: Field, value: string, immediate: boolean) => void;
}) {
  const copy = he.themes.custom;
  const [role, setRole] = useState<Field>("primary");
  const { tokens, adjusted, effective } = deriveTokens(seeds);
  const value = seeds[role];
  const id = `custom-theme-${mode}-${role}`;
  return (
    <section className="space-y-3 rounded-lg border p-3" data-testid={`custom-theme-${mode}`}>
      <h4 className="text-sm font-semibold">{title}</h4>
      <ToggleGroup
        type="single"
        value={role}
        onValueChange={(v) => v && setRole(v as Field)}
        aria-label={title}
        className="grid grid-cols-3 gap-2"
      >
        {FIELDS.map((field) => (
          <ToggleGroupItem
            key={field}
            value={field}
            className="relative min-h-11 gap-2 border px-2 text-sm"
            data-testid={`custom-theme-${mode}-role-${field}`}
          >
            <span
              aria-hidden="true"
              className="inline-block h-4 w-4 shrink-0 rounded-full border"
              style={{ backgroundColor: seeds[field] }}
            />
            <span>{copy[field]}</span>
            {adjusted.includes(field) && (
              <span
                role="img"
                aria-label={copy.adjusted}
                className="absolute end-1 top-1 h-2 w-2 rounded-full bg-amber-500"
              />
            )}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {/* react-colorful does its pointer math in physical coordinates; pinned to ltr so the hue strip
          and saturation square behave the same under the page's dir="rtl". */}
      <div dir="ltr" className="custom-theme-picker" data-testid={`${id}-picker`}>
        <HexColorPicker
          color={value}
          onChange={(c) => onField(role, c, false)}
          style={{ width: "100%", height: 160 }}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{copy[role]}</span>
        <HexColorInput
          prefixed
          color={value}
          onChange={(c) => onField(role, c, true)}
          aria-label={copy[role]}
          dir="ltr"
          className="h-9 w-28 rounded-md border bg-background px-2 text-xs"
          data-testid={id}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {SWATCHES[mode][role].map((hex) => (
          <button
            key={hex}
            type="button"
            aria-label={tv("themes.custom.swatchAria", { hex })}
            aria-pressed={hex.toLowerCase() === value.toLowerCase()}
            data-testid={`${id}-swatch-${hex.slice(1)}`}
            onClick={() => onField(role, hex, true)}
            className="h-8 w-8 rounded-full border-2 border-border aria-pressed:ring-2 aria-pressed:ring-ring aria-pressed:ring-offset-1"
            style={{ backgroundColor: hex }}
          />
        ))}
      </div>
      {adjusted.includes(role) && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid={`${id}-adjusted`}>
          <span>{copy.adjusted}</span>
          <span
            role="img"
            aria-label={copy.effectiveAria}
            className="inline-block h-4 w-4 rounded-full border"
            style={{ backgroundColor: effective[role] }}
          />
          <span dir="ltr">{effective[role]}</span>
        </p>
      )}
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
