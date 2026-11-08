/**
 * Theme contract (REQ §13.196). A theme file (`src/themes/<id>.ts`) describes a look with a few seed colours per
 * mode; `derive.ts` turns them into the full token set and enforces contrast, so a theme file cannot make the app
 * unreadable. Adding a theme: `/add-theme`.
 */
import type { he } from "@/i18n/he";

export type ThemeMode = "light" | "dark";

/** CSS custom property name (without `--`) → `"H S% L%"`. */
export type TokenMap = Record<string, string>;

/** The few colours a theme (or a member's custom theme) picks per mode, as `#rrggbb`. */
export interface ThemeSeeds {
  /** Page background. */
  background: string;
  /** Cards, sheets, popovers. */
  card: string;
  /** Buttons, links, the focus ring, selected chips. */
  primary: string;
  /** Optional soft tint for secondary/accent surfaces (chips, hovers); derived from `primary` when absent. */
  accent?: string;
  /** Optional body text colour; derived (near-black / near-white tinted toward `primary`) when absent. */
  foreground?: string;
}

interface ThemeMotifBase {
  /** Rendered size in px (default 28). */
  size?: number;
  /** Rotation in degrees (default 0). */
  rotate?: number;
}

/**
 * One background motif: an SVG path in a 24×24 box, drawn filled — or a square image (`image`, an imported asset
 * URL; `ThemeBackdrop` inlines it, since an SVG background cannot load files), used for a real logo the owner supplied (the השומר הצעיר emblem).
 */
export type ThemeMotif = (ThemeMotifBase & { d: string; color: string }) | (ThemeMotifBase & { image: string });

/** Faint background decoration (REQ §13.196 d): drawn on a fixed layer behind all content, never over it. */
export interface ThemeDecoration {
  motifs: readonly ThemeMotif[];
  /** Opacity of the whole layer, 0.04–0.2 (clamped). */
  opacity: number;
  /** Motifs per 240×240 tile (clamped 1–14). */
  perTile: number;
  /** Slow drift of the layer; off under "כבה אנימציות" and the device's reduced-motion setting. */
  drift?: boolean;
}

export type ThemeNameKey = keyof typeof he.themes.names;

/** `"neutral"` = use the neutral look of that mode (no variables set — `index.css` paints it). */
export type ThemeModeSpec = ThemeSeeds | "neutral";

export interface ThemeDef {
  id: string;
  nameKey: ThemeNameKey;
  light: ThemeModeSpec;
  /** Presets other than neutral / high visibility are light themes: in dark mode they show neutral dark (REQ §13.196 a). */
  dark: ThemeModeSpec;
  /** Three colours for the picker's swatch card. */
  swatch: readonly [string, string, string];
  /** Corner radius override, e.g. `"0.9rem"` (neutral `0.5rem`). Light mode only for light themes. */
  radius?: string;
  /** Raises every contrast floor (high visibility): text 7:1, borders 3:1. */
  strongContrast?: boolean;
  decoration?: ThemeDecoration;
}

/** A member's own theme (REQ §13.196 a), stored on the device. */
export interface CustomTheme {
  light: ThemeSeeds;
  dark: ThemeSeeds;
}
