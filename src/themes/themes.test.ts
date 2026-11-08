import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";

import { resolveAppearance, DEFAULT_CUSTOM_THEME } from "./apply";
import { contrast, hexToHsl, parseHslVar } from "./color";
import { checkReadability, deriveTokens } from "./derive";
import { NEUTRAL_DARK, NEUTRAL_LIGHT } from "./neutralTokens";
import { CUSTOM_THEME_ID, THEMES } from "./registry";
import type { ThemeSeeds } from "./types";

function cssBlock(css: string, selectorStart: string): Record<string, string> {
  const i = css.indexOf(selectorStart);
  const body = css.slice(css.indexOf("{", i) + 1, css.indexOf("}", i));
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*([0-9.]+ [0-9.]+% [0-9.]+%);/g)].map((m) => [m[1], m[2]]));
}

describe("neutral tokens", () => {
  const css = readFileSync(resolve(__dirname, "../index.css"), "utf8");
  it("mirror src/index.css", () => {
    expect(NEUTRAL_LIGHT).toEqual(cssBlock(css, ":root,"));
    expect(NEUTRAL_DARK).toEqual(cssBlock(css, "\n.dark,"));
  });
});

/** Deliberately bad custom picks (REQ §13.196 b): each must come out readable. */
const BAD_PICKS: Record<string, ThemeSeeds> = {
  "yellow on white": { background: "#ffffff", card: "#ffffff", primary: "#ffff00" },
  "white on white text": { background: "#ffffff", card: "#fafafa", primary: "#ffffff", foreground: "#ffffff" },
  "black everything": { background: "#000000", card: "#000000", primary: "#000000", foreground: "#000000" },
  "neon": { background: "#ff00ff", card: "#00ff00", primary: "#00ffff" },
  "mid grey soup": { background: "#808080", card: "#888888", primary: "#7f7f7f", accent: "#858585" },
  "dark bg dark primary": { background: "#101010", card: "#1a1a1a", primary: "#202060" },
  "pastel": { background: "#ffe4f1", card: "#e4fff4", primary: "#ffd1a8" },
  "pure red page": { background: "#ff0000", card: "#ff3030", primary: "#aa0000" },
  "light text on light": { background: "#f0f0f0", card: "#ffffff", primary: "#3366ff", foreground: "#dddddd" },
  "same card as primary": { background: "#1e1ec8", card: "#1e1ec8", primary: "#1e1ec8" },
};

describe("deriveTokens readability floor", () => {
  for (const [name, seeds] of Object.entries(BAD_PICKS)) {
    it(`bad pick "${name}" is readable after derivation`, () => {
      expect(checkReadability(deriveTokens(seeds).tokens)).toEqual([]);
    });
    it(`bad pick "${name}" is readable at high-visibility floors`, () => {
      expect(checkReadability(deriveTokens(seeds, { strongContrast: true }).tokens, { strongContrast: true })).toEqual([]);
    });
  }

  it("reports a moved primary so the editor can say so", () => {
    expect(deriveTokens(BAD_PICKS["yellow on white"]!).adjusted).toContain("primary");
    expect(deriveTokens({ background: "#ffffff", card: "#ffffff", primary: "#1e1ec8" }).adjusted).toEqual([]);
  });

  it("keeps a picked colour that already reads", () => {
    const { effective } = deriveTokens({ background: "#ffffff", card: "#ffffff", primary: "#1e1ec8" });
    expect(effective.primary).toBe("#1e1ec8");
  });

  it("keeps status hues (meaning) while fixing their contrast", () => {
    const { tokens } = deriveTokens(BAD_PICKS["pure red page"]!);
    for (const token of ["available", "maintenance", "destructive", "mine"]) {
      expect(Math.abs(parseHslVar(tokens[token]).h - parseHslVar(NEUTRAL_LIGHT[token]).h)).toBeLessThan(1);
    }
  });
});

describe("theme registry", () => {
  it("ids are unique and every theme has a Hebrew name", () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(CUSTOM_THEME_ID);
    for (const theme of THEMES) expect(he.themes.names[theme.nameKey]).toBeTruthy();
    expect(he.themes.names.custom).toBeTruthy();
  });

  for (const theme of THEMES) {
    for (const dark of [false, true]) {
      it(`${theme.id} (${dark ? "dark" : "light"}) passes the readability check`, () => {
        const resolved = resolveAppearance(theme.id, DEFAULT_CUSTOM_THEME, dark);
        const tokens = resolved.tokens ?? (dark ? NEUTRAL_DARK : NEUTRAL_LIGHT); // null = neutral, painted by index.css
        expect(checkReadability(tokens, { strongContrast: resolved.tokens ? theme.strongContrast : false })).toEqual([]);
      });
    }
    it(`${theme.id}: swatch colours are hex`, () => {
      for (const c of theme.swatch) expect(() => hexToHsl(c)).not.toThrow();
    });
  }

  it("light-only presets show neutral dark in dark mode", () => {
    for (const theme of THEMES.filter((t) => t.light !== "neutral" && t.dark === "neutral")) {
      const r = resolveAppearance(theme.id, DEFAULT_CUSTOM_THEME, true);
      expect(r.tokens).toBeNull();
      expect(r.decoration).toBeNull();
      expect(r.themeId).toBe("neutral");
    }
  });

  it("custom resolves per mode from its own seeds", () => {
    const custom = { light: BAD_PICKS.pastel!, dark: BAD_PICKS["dark bg dark primary"]! };
    const light = resolveAppearance(CUSTOM_THEME_ID, custom, false).tokens!;
    const dark = resolveAppearance(CUSTOM_THEME_ID, custom, true).tokens!;
    expect(light.background).not.toBe(dark.background);
    expect(contrast(parseHslVar(dark.foreground), parseHslVar(dark.background))).toBeGreaterThanOrEqual(4.5);
  });
});
