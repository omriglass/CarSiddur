import type { ThemeDef } from "../types";

/** Today's look and the default (REQ §13.196): no variables set, `src/index.css` paints both modes. */
export const neutral: ThemeDef = {
  id: "neutral",
  nameKey: "neutral",
  light: "neutral",
  dark: "neutral",
  swatch: ["#f2f5f9", "#0a3fa6", "#ffffff"],
};
