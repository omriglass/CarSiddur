---
name: add-theme
description: Add a new look (theme) to Profile → מראה — a preset like a festive theme (Pesach, Sukkot, Hanukkah, Independence Day…), a seasonal or department theme, or change an existing preset's colours or background decoration. Use when asked to "add a theme", "make a Hanukkah theme", "festive look", "change the fun theme's colours", "add decorations to a theme". One file plus a registry line; the shared code derives and contrast-checks every colour, so a theme cannot make the app unreadable (REQ §13.196).
---

# Add a theme

Themes are per device, client-only (no migration, no DB). The engine is `src/themes/`:

- `types.ts` — `ThemeDef` (the contract), `ThemeSeeds`, `ThemeDecoration`, `ThemeMotif`.
- `derive.ts` — seeds → full token set; `repair()` enforces the readability floor (text 4.5:1, `strongContrast` 7:1; text on fills 4.5:1; status/ride marks 3:1 on cards; borders 1.25:1 / 3:1). **Never loosen it to make a theme pass — change the seeds.**
- `apply.ts` — storage keys and `applyAppearance()`; `registry.ts` — the one list; `presets/*.ts` — one file per theme.
- `src/components/ThemeBackdrop.tsx` — draws `decoration` on a fixed layer behind all content.
- `.theme-grid-neutral` (`src/index.css`) keeps the siddur/board grids neutral in every theme (REQ §13.196 c) — a theme never restyles the grid.

## Steps

1. **Requirements first** (hard rule 2): add the theme by name to REQ §13.196's list and UX_FLOWS Profile 2b's list. A temporary festive theme: say so ("עד אחרי החג" is the member's choice — themes are never switched on automatically unless REQUIREMENTS says so).
2. **Name**: `src/i18n/he.member.ts` → `themes.names.<id>: "<Hebrew name>"` (camelCase id).
3. **File** `src/themes/presets/<id>.ts`, copying the shape of an existing preset (`fun.ts` has decoration with drift, `calming.ts` without):
   - `light`: seeds `{ background, card, primary, accent? }` as `#rrggbb`. Keep the page background light and low-saturation; strong brand colours go in `primary`, the hero gradient and decoration — a saturated page background fights every card and status badge.
   - `dark: "neutral"` for a light-only preset (the default for presets — REQ §13.196 a: dark mode shows the shared neutral dark). Only neutral and high visibility have their own dark looks; adding another dark look needs the owner's OK and a REQUIREMENTS change.
   - `swatch`: three hex colours for the picker card (page, primary, accent).
   - optional `radius` (e.g. `"0.9rem"`), `decoration: { motifs: [{ d, color, size?, rotate? }], opacity (0.04–0.2), perTile (1–14), drift? }` — `d` is an SVG path in a 24×24 box, filled; abstract symbols, no copied logos or trademarks; colours are decoration only (never text).
4. **Register** it: one import + one entry in `THEMES` (`src/themes/registry.ts`). Order = picker order; festive themes after the permanent ones.
5. **Test**: `npx vitest run src/themes` — the registry test runs every preset (light + dark) through `checkReadability`, checks the Hebrew name and swatch. A failure names the pair and ratio; adjust the seeds.
6. **Look at it**: `npx playwright test e2e/themes.spec.ts` (needs the local stack on a disposable copy; the spec loops over `THEMES`, so a new theme is covered automatically) and open the screenshots: siddur, board, /my and the request form, light and dark. Check: text readable, decoration faint and only between cards, grids identical to neutral, StatusBadge colours unchanged in meaning.
7. `npm run check`; TODO/RELEASES as usual. No `TEST_MAP` change unless you add files outside `src/themes/presets/`.

## Do not

- Set colours anywhere but the theme file (no per-theme CSS for colours; `html[data-theme="<id>"]` CSS only for non-colour extras, as high visibility does, and never inside `.theme-grid-neutral`).
- Put decoration over content (`ThemeBackdrop` is the only place it renders).
- Touch `derive.ts`'s floors or `neutralTokens.ts` (it mirrors `index.css`; the test keeps them equal).
