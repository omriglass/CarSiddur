import type { ThemeDef } from "../types";

/** High visibility: black on white / white on black, strong outlines and focus rings (CSS in `src/index.css`), no decoration. */
export const highVis: ThemeDef = {
  id: "highVis",
  nameKey: "highVis",
  light: { background: "#ffffff", card: "#ffffff", primary: "#0033cc", foreground: "#000000" },
  dark: { background: "#000000", card: "#0a0a0a", primary: "#ffd400", foreground: "#ffffff" },
  swatch: ["#ffffff", "#0033cc", "#000000"],
  strongContrast: true,
};
