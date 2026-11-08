import type { ThemeDef } from "../types";

/** השומר הצעיר: royal blue and white. Blue lives in primary, the hero gradient and the decoration; the page stays near-white. */
const STAR_OUTLINE =
  "M12 1L15.18 6.5L21.53 6.5L18.35 12L21.53 17.5L15.18 17.5L12 23L8.82 17.5L2.47 17.5L5.65 12L2.47 6.5L8.82 6.5zM9.46 7.6L4.38 7.6L6.92 12L4.38 16.4L9.46 16.4L12 20.8L14.54 16.4L19.62 16.4L17.08 12L19.62 7.6L14.54 7.6L12 3.2z";
/** A simplified lily: a centre petal, two curled side petals and a band. */
const LILY = "M12 7C14 9 14.2 11.5 12 14C9.8 11.5 10 9 12 7zM8.6 9.5C10.8 10.1 11.9 11.8 11.8 14C9.5 13.7 8.2 12 8.6 9.5zM15.4 9.5C13.2 10.1 12.1 11.8 12.2 14C14.5 13.7 15.8 12 15.4 9.5zM9.5 15.2H14.5V16.4H9.5z";
const EMBLEM = `${STAR_OUTLINE}${LILY}`;
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
      { d: EMBLEM, color: "#1e1ec8", size: 44, rotate: -8 },
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
