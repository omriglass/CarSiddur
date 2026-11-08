/**
 * Puts the chosen look on `<html>` (REQ §13.196): the `dark` class for the mode, the derived tokens as inline CSS
 * variables (none for neutral — `index.css` paints it), and `data-theme` for theme-specific CSS (high visibility)
 * and the background decoration. Per device only: three `localStorage` keys, nothing in the database.
 */
import { hslToHex, isHex, parseHslVar } from "./color";
import { deriveTokens } from "./derive";
import { NEUTRAL_DARK, NEUTRAL_LIGHT } from "./neutralTokens";
import { CUSTOM_THEME_ID, DEFAULT_THEME_ID, findTheme } from "./registry";
import type { CustomTheme, ThemeDecoration, ThemeMode, ThemeSeeds, TokenMap } from "./types";

export type ModePreference = ThemeMode | "system";

const MODE_KEY = "nevo-theme"; // light/dark/system since the visual pass; kept so nobody's choice resets
const THEME_KEY = "nevo-theme-id.v1";
const CUSTOM_KEY = "nevo-theme-custom.v1";
const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";
/** Fired on `window` after every apply, so `ThemeBackdrop` and open pickers follow a change made elsewhere. */
export const THEME_CHANGE_EVENT = "nevo-theme-change";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // A convenience only; storage may be denied in private browsing.
  }
}

function neutralSeeds(map: TokenMap): ThemeSeeds {
  return {
    background: hslToHex(parseHslVar(map.background)),
    card: hslToHex(parseHslVar(map.card)),
    primary: hslToHex(parseHslVar(map.primary)),
  };
}

/** Where a new custom theme starts: the neutral colours of each mode. */
export const DEFAULT_CUSTOM_THEME: CustomTheme = { light: neutralSeeds(NEUTRAL_LIGHT), dark: neutralSeeds(NEUTRAL_DARK) };

function isSeeds(value: unknown): value is ThemeSeeds {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const hex = (x: unknown) => typeof x === "string" && isHex(x);
  return hex(v.background) && hex(v.card) && hex(v.primary) && (v.accent === undefined || hex(v.accent)) && (v.foreground === undefined || hex(v.foreground));
}

export function getStoredMode(): ModePreference {
  const stored = read(MODE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

export function getStoredThemeId(): string {
  const stored = read(THEME_KEY);
  return stored && (stored === CUSTOM_THEME_ID || findTheme(stored)) ? stored : DEFAULT_THEME_ID;
}

export function getStoredCustomTheme(): CustomTheme {
  try {
    const parsed: unknown = JSON.parse(read(CUSTOM_KEY) ?? "null");
    if (parsed && typeof parsed === "object") {
      const { light, dark } = parsed as Record<string, unknown>;
      if (isSeeds(light) && isSeeds(dark)) return { light, dark };
    }
  } catch {
    // Unreadable → start again from neutral.
  }
  return DEFAULT_CUSTOM_THEME;
}

export function storeMode(mode: ModePreference): void {
  write(MODE_KEY, mode);
}
export function storeThemeId(id: string): void {
  write(THEME_KEY, id === DEFAULT_THEME_ID ? null : id);
}
export function storeCustomTheme(custom: CustomTheme): void {
  write(CUSTOM_KEY, JSON.stringify(custom));
}

export function resolveIsDark(mode: ModePreference): boolean {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(DARK_MEDIA_QUERY).matches;
}

export interface ResolvedAppearance {
  dark: boolean;
  /** `data-theme` value; the active theme id, or `neutral` when a light-only preset shows neutral dark. */
  themeId: string;
  /** Inline variables to set; null = neutral (`index.css`). */
  tokens: TokenMap | null;
  radius: string | null;
  decoration: ThemeDecoration | null;
}

/** Pure: what a given choice looks like in a given mode. */
export function resolveAppearance(themeId: string, custom: CustomTheme, dark: boolean): ResolvedAppearance {
  const mode: ThemeMode = dark ? "dark" : "light";
  if (themeId === CUSTOM_THEME_ID) {
    return { dark, themeId, tokens: deriveTokens(custom[mode]).tokens, radius: null, decoration: null };
  }
  const theme = findTheme(themeId) ?? findTheme(DEFAULT_THEME_ID)!;
  const spec = theme[mode];
  if (spec === "neutral") return { dark, themeId: dark && theme.light !== "neutral" ? DEFAULT_THEME_ID : theme.id, tokens: null, radius: null, decoration: null };
  return {
    dark,
    themeId: theme.id,
    tokens: deriveTokens(spec, { strongContrast: theme.strongContrast }).tokens,
    radius: theme.radius ?? null,
    decoration: theme.decoration ?? null,
  };
}

let appliedVars: string[] = [];
let current: ResolvedAppearance | null = null;

export function currentAppearance(): ResolvedAppearance | null {
  return current;
}

/** Applies the stored choice (or the given one) to `<html>`. Synchronous — `main.tsx` calls it before the first paint. */
export function applyAppearance(
  mode: ModePreference = getStoredMode(),
  themeId: string = getStoredThemeId(),
  custom: CustomTheme = getStoredCustomTheme(),
): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const resolved = resolveAppearance(themeId, custom, resolveIsDark(mode));
  root.classList.toggle("dark", resolved.dark);
  for (const name of appliedVars) root.style.removeProperty(name);
  appliedVars = [];
  const vars: TokenMap = { ...(resolved.tokens ?? {}), ...(resolved.radius ? { radius: resolved.radius } : {}) };
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(`--${name}`, value);
    appliedVars.push(`--${name}`);
  }
  root.setAttribute("data-theme", resolved.themeId);
  current = resolved;
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

let mediaInstalled = false;

/** Called once from `main.tsx`: apply now, and follow the device's dark setting live while the mode is "system". */
export function installAppearance(): void {
  applyAppearance();
  if (mediaInstalled || typeof window.matchMedia !== "function") return;
  mediaInstalled = true;
  window.matchMedia(DARK_MEDIA_QUERY).addEventListener("change", () => {
    if (getStoredMode() === "system") applyAppearance();
  });
}
