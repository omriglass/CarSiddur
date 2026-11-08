import type { ThemeDef } from "../types";

const LEAF = "M4 20C4 10 10 4 20 4c0 10-6 16-16 16zM4 20l9-9";
const WAVE = "M1 12c3-4 5-4 8 0s5 4 8 0 5-4 6-2v4c-1-2-3-2-6 2s-5 4-8 0-5-4-8 0z";

export const calming: ThemeDef = {
  id: "calming",
  nameKey: "calming",
  light: { background: "#f1f5f0", card: "#fbfdfa", primary: "#2f6b4f", accent: "#d9eee2" },
  dark: "neutral",
  swatch: ["#f1f5f0", "#2f6b4f", "#cfe8d9"],
  radius: "0.75rem",
  decoration: {
    opacity: 0.1,
    perTile: 5,
    motifs: [
      { d: LEAF, color: "#2f6b4f", size: 34, rotate: 15 },
      { d: LEAF, color: "#7fb59a", size: 28, rotate: 190 },
      { d: WAVE, color: "#7fb59a", size: 60 },
      { d: WAVE, color: "#b7d9c6", size: 48, rotate: 180 },
    ],
  },
};
