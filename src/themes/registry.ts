/**
 * The one list of themes (REQ §13.196 f). Adding a theme = a file in `presets/` plus one line here plus its name
 * in `he.themes.names` (`/add-theme`); `registry.test.ts` runs every entry through the readability check.
 */
import { blauweiss } from "./presets/blauweiss";
import { calming } from "./presets/calming";
import { fun } from "./presets/fun";
import { highVis } from "./presets/highVis";
import { neutral } from "./presets/neutral";
import type { ThemeDef } from "./types";

export const THEMES: readonly ThemeDef[] = [neutral, blauweiss, highVis, fun, calming];

export const DEFAULT_THEME_ID = neutral.id;
/** The member's own colours (REQ §13.196 a); not a registry entry — its seeds come from the device. */
export const CUSTOM_THEME_ID = "custom";

export function findTheme(id: string): ThemeDef | undefined {
  return THEMES.find((theme) => theme.id === id);
}
