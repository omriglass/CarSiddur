/**
 * Seeds → full token set, with the readability floor enforced (REQ §13.196 b). Every theme other than neutral,
 * and every custom theme, goes through `deriveTokens`, so no seed choice can produce unreadable text, invisible
 * borders or a status colour that disappears into its card. `checkReadability` is the same rule set as a report —
 * the unit tests run every preset and a list of deliberately bad picks through it.
 */
import { contrast, ensureContrast, hexToHsl, hslToHex, isDark, mix, parseHslVar, toHslVar, withLightness, type Hsl } from "./color";
import { NEUTRAL_DARK, NEUTRAL_LIGHT } from "./neutralTokens";
import type { ThemeSeeds, TokenMap } from "./types";

export const TEXT_RATIO = 4.5;
export const STRONG_TEXT_RATIO = 7;
export const UI_RATIO = 3;
export const BORDER_RATIO = 1.25;

/** Status/category colours read as marks on cards (3:1); each keeps its neutral hue in every theme. */
const MARK_TOKENS = [
  "available", "maintenance", "destructive", "mine", "calendar",
  "ride-work", "ride-childcare", "ride-healthcare", "ride-errands", "ride-other", "ride-green", "ride-yellow", "ride-red",
] as const;

type Floor = "text" | "fill" | "ui" | "border";

/**
 * `[foreground, surface, floor]`: text on surfaces (4.5:1, high visibility 7:1); text on a solid status/button
 * fill (4.5:1 in every theme — the fill keeps its hue, so 7:1 is not always reachable); marks on cards (3:1);
 * borders (1.25:1, high visibility 3:1).
 */
const RULES: ReadonlyArray<readonly [string, string, Floor]> = [
  ["foreground", "background", "text"], ["foreground", "card", "text"], ["foreground", "muted", "text"],
  ["card-foreground", "card", "text"], ["popover-foreground", "popover", "text"],
  ["muted-foreground", "background", "text"], ["muted-foreground", "card", "text"], ["muted-foreground", "muted", "text"],
  ["secondary-foreground", "secondary", "text"], ["accent-foreground", "accent", "text"],
  ["primary", "background", "text"], ["primary", "card", "text"],
  ["delta", "delta-soft", "text"], ["calendar-foreground", "card", "text"],
  ["primary-foreground", "primary", "fill"], ["booked-foreground", "booked", "fill"],
  ["destructive-foreground", "destructive", "fill"], ["available-foreground", "available", "fill"], ["maintenance-foreground", "maintenance", "fill"],
  ["ring", "background", "ui"], ["ring", "card", "ui"],
  ...MARK_TOKENS.flatMap((t) => [[t, "card", "ui"], [t, "background", "ui"]] as const),
  ["border", "card", "border"], ["border", "background", "border"], ["input", "card", "border"], ["input", "background", "border"],
];

function floorRatio(floor: Floor, strong: boolean): number {
  switch (floor) {
    case "text": return strong ? STRONG_TEXT_RATIO : TEXT_RATIO;
    case "fill": return TEXT_RATIO;
    case "ui": return UI_RATIO;
    case "border": return strong ? UI_RATIO : BORDER_RATIO;
  }
}

/** Seeds the member picked; the repair pass moves them only as a last resort. */
const SEED_SURFACES = new Set(["background", "card"]);

/**
 * Makes every rule hold: first moves the foreground (against all its surfaces at once), then — when no lightness of
 * it can satisfy them all — moves the surface toward the other end. Derived surfaces go first; a seeded background
 * or card only when nothing else helps (the editor then says so).
 */
function repair(t: Record<string, Hsl>, strong: boolean, movedSeeds: Set<string>): void {
  for (let round = 0; round < 8; round += 1) {
    const failing = RULES.filter(([a, b, f]) => contrast(at(t, a), at(t, b)) < floorRatio(f, strong));
    if (failing.length === 0) return;
    for (const [a, b, f] of failing) {
      const required = floorRatio(f, strong);
      if (contrast(at(t, a), at(t, b)) >= required) continue;
      const own = RULES.filter(([x]) => x === a);
      const maxRequired = Math.max(...own.map(([, , g]) => floorRatio(g, strong)));
      t[a] = ensureContrast(at(t, a), own.map(([, y]) => at(t, y)), maxRequired);
      if (contrast(at(t, a), at(t, b)) >= required) continue;
      // No lightness of `a` reads on all its surfaces: move this surface away from `a` (its other foregrounds are
      // repaired in the next round).
      t[b] = ensureContrast(at(t, b), [at(t, a)], required);
      if (SEED_SURFACES.has(b)) movedSeeds.add(b);
    }
  }
}

export interface DeriveOptions {
  /** High visibility: text 7:1, borders 3:1. */
  strongContrast?: boolean;
}

export interface DerivedTheme {
  /** HSL tokens (`"H S% L%"`) plus `gradient-hero`, `gradient-card`, `shadow-elegant`, `shadow-card` as CSS values. */
  tokens: TokenMap;
  /** Seeds the readability floor moved (the custom editor shows "הותאם לקריאוּת" next to them). */
  adjusted: Array<keyof ThemeSeeds>;
  /** The seeds after adjustment, as hex. */
  effective: ThemeSeeds;
}

const WHITE: Hsl = { h: 0, s: 0, l: 100 };

/** White or near-black text, whichever reads better on `surface`, then pushed to `ratio`. */
function onColor(surface: Hsl, ratio: number): Hsl {
  const ink: Hsl = { h: surface.h, s: 30, l: 10 };
  const pick = contrast(WHITE, surface) >= contrast(ink, surface) ? WHITE : ink;
  return ensureContrast(pick, [surface], ratio);
}

function at(t: Record<string, Hsl>, token: string): Hsl {
  const value = t[token];
  if (!value) throw new Error(`missing token ${token}`);
  return value;
}

function shift(c: Hsl, by: number): Hsl {
  return withLightness(c, c.l + by);
}

export function deriveTokens(seeds: ThemeSeeds, options: DeriveOptions = {}): DerivedTheme {
  const textRatio = options.strongContrast ? STRONG_TEXT_RATIO : TEXT_RATIO;
  const borderRatio = options.strongContrast ? UI_RATIO : BORDER_RATIO;

  const background = hexToHsl(seeds.background);
  const card = hexToHsl(seeds.card);
  const dark = isDark(background);
  const base = dark ? NEUTRAL_DARK : NEUTRAL_LIGHT;
  const away = dark ? 1 : -1; // toward the text side of the page
  const primarySeed = hexToHsl(seeds.primary);

  const tint = mix(background, primarySeed, 0.12);
  const muted = shift(tint, away * 5);
  const secondary = seeds.accent ? hexToHsl(seeds.accent) : shift(mix(background, primarySeed, 0.2), away * 8);
  const surfaces = [background, card, muted, secondary];

  const fgSeed = seeds.foreground ? hexToHsl(seeds.foreground) : { h: primarySeed.h, s: dark ? 20 : 30, l: dark ? 96 : 11 };
  const foreground = ensureContrast(fgSeed, surfaces, textRatio);
  const mutedForeground = ensureContrast(mix(foreground, background, 0.42), [background, card, muted], textRatio);

  const primary = ensureContrast(primarySeed, [background, card], textRatio);
  const primaryForeground = onColor(primary, textRatio);

  const borderSeed = shift(mix(background, primarySeed, 0.15), away * 10);
  const border = ensureContrast(borderSeed, [background, card], borderRatio);

  const t: Record<string, Hsl> = {
    background, foreground, card, "card-foreground": foreground, popover: card, "popover-foreground": foreground,
    primary, "primary-foreground": primaryForeground,
    secondary, "secondary-foreground": ensureContrast(foreground, [secondary], textRatio),
    muted, "muted-foreground": mutedForeground,
    accent: secondary, "accent-foreground": ensureContrast(foreground, [secondary], textRatio),
    border, input: border, ring: ensureContrast(primary, [background, card], UI_RATIO),
    booked: primary, "booked-foreground": primaryForeground,
  };
  for (const token of MARK_TOKENS) t[token] = ensureContrast(parseHslVar(base[token]), [background, card], UI_RATIO);
  for (const token of ["destructive", "available", "maintenance"] as const) t[`${token}-foreground`] = onColor(at(t, token), textRatio);
  t["delta-soft"] = parseHslVar(base["delta-soft"]);
  t.delta = ensureContrast(parseHslVar(base.delta), [at(t, "delta-soft")], textRatio);
  t["calendar-foreground"] = ensureContrast(parseHslVar(base["calendar-foreground"]), [card], textRatio);
  const movedSeeds = new Set<string>();
  repair(t, Boolean(options.strongContrast), movedSeeds);
  t.popover = at(t, "card");

  const tokens: TokenMap = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, toHslVar(v)]));
  const heroEnd = shift(at(t, "primary"), dark ? -6 : 8);
  const heroEndReads = contrast(at(t, "primary-foreground"), heroEnd) >= TEXT_RATIO;
  tokens["gradient-hero"] = `linear-gradient(135deg, hsl(${tokens.primary}), hsl(${toHslVar(heroEndReads ? heroEnd : at(t, "primary"))}))`;
  tokens["gradient-card"] = `linear-gradient(180deg, hsl(${tokens.card}), hsl(${toHslVar(shift(at(t, "card"), away * 2))}))`;
  tokens["shadow-elegant"] = dark ? "0 4px 20px -4px hsl(0 0% 0% / 0.5)" : `0 4px 20px -4px hsl(${tokens.primary} / 0.15)`;
  tokens["shadow-card"] = dark ? "0 2px 10px -2px hsl(0 0% 0% / 0.35)" : `0 2px 10px -2px hsl(${tokens.foreground} / 0.08)`;

  // A nudge of a point or two is not worth telling the member about.
  const moved = (a: Hsl, b: Hsl) => Math.abs(a.l - b.l) > 2;
  const adjusted: Array<keyof ThemeSeeds> = [];
  if (moved(primarySeed, at(t, "primary"))) adjusted.push("primary");
  if (seeds.foreground && moved(fgSeed, at(t, "foreground"))) adjusted.push("foreground");
  if (movedSeeds.has("background")) adjusted.push("background");
  if (movedSeeds.has("card")) adjusted.push("card");

  return {
    tokens,
    adjusted,
    effective: {
      ...seeds,
      background: hslToHex(at(t, "background")),
      card: hslToHex(at(t, "card")),
      primary: hslToHex(at(t, "primary")),
      ...(seeds.foreground ? { foreground: hslToHex(at(t, "foreground")) } : {}),
    },
  };
}

export interface ReadabilityFailure {
  pair: readonly [string, string];
  ratio: number;
  required: number;
}

/** Every pair of `tokens` below its floor (empty = readable). Same rules `deriveTokens` enforces. */
export function checkReadability(tokens: TokenMap, options: DeriveOptions = {}): ReadabilityFailure[] {
  const failures: ReadabilityFailure[] = [];
  for (const [a, b, floor] of RULES) {
    if (!(a in tokens) || !(b in tokens)) throw new Error(`missing token in pair ${a}/${b}`);
    const required = floorRatio(floor, Boolean(options.strongContrast));
    const ratio = contrast(parseHslVar(tokens[a]), parseHslVar(tokens[b]));
    // 0.02 slack: tokens are rounded to one decimal when written.
    if (ratio + 0.02 < required) failures.push({ pair: [a, b], ratio: Math.round(ratio * 100) / 100, required });
  }
  return failures;
}

