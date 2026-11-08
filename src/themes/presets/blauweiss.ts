import logo from "../assets/hashomer-logo.png";
import type { ThemeDef } from "../types";

/**
 * השומר הצעיר: royal blue and white. Blue lives in primary, the hero gradient and the decoration; the page stays near-white.
 * The emblem is the movement's own logo (owner-supplied 2026-11-08, `assets/hashomer-logo.png`: 256 px, recoloured to the
 * theme blue on a transparent background).
 */
const STAR5 = "M12 2l2.9 6.6 7.1.7-5.3 4.8 1.5 7-6.2-3.6-6.2 3.6 1.5-7L2 9.3l7.1-.7z";
const BLOB = "M12 2C17 2 21 6 21 11.5S16.5 22 11.5 21.5C6 21 2.5 16.5 3 11.5S7 2 12 2z";
const LEAF = "M4 20C4 10 10 4 20 4c0 10-6 16-16 16zM4 20l9-9";

export const blauweiss: ThemeDef = {
  id: "blauweiss",
  nameKey: "blauweiss",
  light: { background: "#f4f7fd", card: "#ffffff", primary: "#1e1ec8", accent: "#e3e9fb" },
  dark: "neutral",
  swatch: ["#f4f7fd", "#1e1ec8", "#e0915a"],
  radius: "0.7rem",
  decoration: {
    opacity: 0.14,
    perTile: 8,
    motifs: [
      { image: logo, size: 64, rotate: -6 },
      { d: STAR5, color: "#1e1ec8", size: 16, rotate: 12 },
      { d: STAR5, color: "#e0915a", size: 14, rotate: -20 },
      { d: BLOB, color: "#dff6f8", size: 56 },
      { d: BLOB, color: "#fcd3c9", size: 48, rotate: 70 },
      { d: LEAF, color: "#3a2a2e", size: 30, rotate: 25 },
      { d: LEAF, color: "#f38c90", size: 26, rotate: 200 },
      { d: BLOB, color: "#e0915a", size: 28, rotate: 130 },
    ],
  },
};
