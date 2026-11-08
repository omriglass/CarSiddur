import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { paths } from "../src/app/routes";
import { CUSTOM_THEME_ID, THEMES } from "../src/themes/registry";
import { getWeekStart, NEVO_DEPARTMENT_ID, SEEDED_USERS, signIn } from "./helpers";

// Themes (REQ §13.196, TODO TH4): every theme × light/dark on the screens members and the Sadran read most —
// siddur, board, /my and the request form. Screenshots land in test-results/themes/ for a human look; the
// rendered-contrast probe fails a theme that makes text worse than the neutral look does, and the grids must
// paint exactly the neutral colours (REQ §13.196 c).
test.use({ viewport: { width: 390, height: 844 } });

const OUT = path.join("test-results", "themes");
/** A deliberately bad custom pick: yellow accent on white, white text on white — must still read. */
const BAD_CUSTOM = {
  light: { background: "#ffffff", card: "#ffffff", primary: "#ffff00", foreground: "#ffffff" },
  dark: { background: "#000000", card: "#000000", primary: "#000000", foreground: "#000000" },
};

type Look = { id: string; mode: "light" | "dark" };
const LOOKS: Look[] = [...THEMES.map((t) => t.id), CUSTOM_THEME_ID].flatMap((id) => [
  { id, mode: "light" as const },
  { id, mode: "dark" as const },
]);

async function useLook(page: Page, look: Look): Promise<void> {
  await page.addInitScript(
    ([id, mode, custom]) => {
      try {
        window.localStorage.setItem("nevo-theme", mode);
        window.localStorage.setItem("nevo-theme-id.v1", id);
        window.localStorage.setItem("nevo-theme-custom.v1", custom);
        window.localStorage.setItem("a11y.reduceMotion.v1", "1");
      } catch {
        /* ignore */
      }
    },
    [look.id, look.mode, JSON.stringify(BAD_CUSTOM)] as const,
  );
}

/** Text elements whose colour reads below `min` against the first opaque background behind them. */
async function lowContrastTexts(page: Page, min: number): Promise<string[]> {
  return page.evaluate((minRatio) => {
    const parse = (c: string): [number, number, number, number] | null => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m?.[1]) return null;
      const [r = 0, g = 0, b = 0, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return [r, g, b, a];
    };
    const lum = ([r = 0, g = 0, b = 0]: number[]) => {
      const f = (v: number) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (el: Element | null): number[] | null => {
      for (let e = el; e; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.backgroundImage !== "none") return null; // gradient/image: not measurable here
        const c = parse(s.backgroundColor);
        if (c && c[3] >= 0.95) return c;
      }
      return [255, 255, 255, 1];
    };
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !n.textContent?.trim()) continue;
      seen.add(el);
      const s = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (s.visibility === "hidden" || Number(s.opacity) < 0.5 || rect.width === 0 || rect.height === 0) continue;
      if (el.closest("[aria-hidden='true'], [disabled], [aria-disabled='true'], [data-disabled]")) continue;
      const fg = parse(s.color);
      const bg = bgOf(el);
      if (!fg || !bg || fg[3] < 0.5) continue;
      const a = lum(fg), b = lum(bg);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (ratio < minRatio) out.push(`${el.tagName.toLowerCase()} "${n.textContent.trim().slice(0, 24)}" ${ratio.toFixed(2)}`);
    }
    return out;
  }, min);
}

async function screens(): Promise<Array<{ name: string; url: string }>> {
  const live = await getWeekStart("live");
  return [
    { name: "my", url: paths.my() },
    { name: "siddur", url: paths.siddur({ dept: NEVO_DEPARTMENT_ID, week: live }) },
    { name: "board", url: paths.sadran.board(NEVO_DEPARTMENT_ID, live) },
    { name: "request", url: paths.requests.new({ week: await getWeekStart("open") }) },
  ];
}

const baseline = new Map<string, Set<string>>();
const key = (entry: string) => entry.replace(/ [\d.]+$/, "");

test.describe.configure({ mode: "serial" });

test.describe("themes", { tag: ["@themes"] }, () => {
  for (const look of LOOKS) {
    test(`${look.id} ${look.mode}: readable on siddur, board, my rides and the request form`, async ({ page }) => {
      fs.mkdirSync(OUT, { recursive: true });
      await useLook(page, look);
      await signIn(page, SEEDED_USERS.sadran);
      for (const screen of await screens()) {
        await page.goto(screen.url);
        await page.waitForLoadState("networkidle");
        await page.screenshot({ path: path.join(OUT, `${look.id}-${look.mode}-${screen.name}.png`), fullPage: false });

        // Grids keep neutral colours: the scope's background equals neutral's (REQ §13.196 c).
        const grid = page.locator(".theme-grid-neutral").first();
        if (await grid.count()) {
          const gridBg = await grid.evaluate((el) => getComputedStyle(el).getPropertyValue("--background").trim());
          expect(gridBg, `${screen.name} grid background`).toBe(look.mode === "dark" ? "222 47% 8%" : "214 32% 96%");
        }

        // No text below 3:1 that the neutral look of the same mode does not already have.
        const low = await lowContrastTexts(page, 3);
        const baseKey = `${look.mode}-${screen.name}`;
        if (look.id === "neutral") {
          baseline.set(baseKey, new Set(low.map(key)));
          continue;
        }
        const known = baseline.get(baseKey) ?? new Set<string>();
        const worse = low.filter((entry) => !known.has(key(entry)));
        expect(worse, `${look.id} ${look.mode} ${screen.name}: text below 3:1`).toEqual([]);
      }
    });
  }
});
