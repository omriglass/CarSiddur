import type { ThemeDef } from "../types";

const SPARKLE = "M12 1c.8 6.2 4.8 10.2 11 11-6.2.8-10.2 4.8-11 11-.8-6.2-4.8-10.2-11-11 6.2-.8 10.2-4.8 11-11z";
const PIN = "M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z";
const DOT = "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z";

export const fun: ThemeDef = {
  id: "fun",
  nameKey: "fun",
  light: { background: "#f6eefb", card: "#ffffff", primary: "#3b2a9a", accent: "#fff1b8", foreground: "#1e1448" },
  dark: "neutral",
  swatch: ["#f6eefb", "#3b2a9a", "#ffd23f"],
  radius: "0.9rem",
  decoration: {
    opacity: 0.2,
    perTile: 9,
    drift: true,
    motifs: [
      { d: SPARKLE, color: "#ffd23f", size: 26, rotate: 0 },
      { d: SPARKLE, color: "#36d0ea", size: 20, rotate: 15 },
      { d: SPARKLE, color: "#ff4f8b", size: 18 },
      { d: PIN, color: "#4fe0a3", size: 28, rotate: -12 },
      { d: PIN, color: "#ff4f8b", size: 24, rotate: 14 },
      { d: DOT, color: "#ffd23f", size: 10 },
      { d: DOT, color: "#36d0ea", size: 12 },
      { d: DOT, color: "#4fe0a3", size: 9 },
    ],
  },
};
