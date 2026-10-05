// Playwright session helper for the QA "UI day": `openAs(email)` returns a signed-in page on the
// DISPOSABLE stack (dev server on :8092 pointed at it). Import it from a short script:
//   import { openAs } from "./scripts/qa/uiSession.mjs";
//   const { page, close, urls } = await openAs("sadran@s7.qa.local", { viewport: "desktop" });
//   await page.goto(urls.board()); await page.screenshot({ path: "board.png", fullPage: true }); await close();
// No Hebrew literals here: the login form is addressed by input type.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { assertDisposable, qaEnv } from "./lib/stack.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const UI_PORT = Number(process.env.QA_UI_PORT ?? 8092);
export const UI_URL = `http://localhost:${UI_PORT}`;

async function up() {
  try { const res = await fetch(UI_URL, { signal: AbortSignal.timeout(2500) }); return res.ok; } catch { return false; }
}

/** Starts (or reuses) the Vite dev server on :8092 with the disposable stack's API url baked in. */
export async function ensureDevServer() {
  const env = qaEnv();
  assertDisposable(env.VITE_SUPABASE_URL);
  if (await up()) return;
  const child = spawn("npx", ["vite", "--port", String(UI_PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: ROOT, detached: true, stdio: "ignore", env: { ...process.env, ...env, VITE_APP_URL: UI_URL },
  });
  child.unref();
  for (let i = 0; i < 90; i++) { if (await up()) return; await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error(`dev server did not come up on ${UI_URL}`);
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

/** Password for `email`: --password/QA_PASSWORD, the QA world's Sadran / personas members, else the demo defaults. */
export function passwordFor(email, out = process.env.QA_OUT) {
  if (process.env.QA_PASSWORD) return process.env.QA_PASSWORD;
  if (out) {
    const world = readJson(path.join(out, "world.json"));
    if (world?.sadran?.email === email) return world.sadran.password;
    const personas = readJson(path.join(out, "personas.json"));
    const member = personas?.members?.find((m) => m.email === email);
    if (member) return member.password;
  }
  return email.endsWith(".qa.local") ? "qa-member-1234" : "nevo-demo-1234";
}

export function scopeFrom(out = process.env.QA_OUT) {
  const world = out ? readJson(path.join(out, "world.json")) : null;
  const personas = out ? readJson(path.join(out, "personas.json")) : null;
  const source = world ?? personas ?? {};
  return { dept: source.department?.id ?? process.env.QA_DEPT, week: source.weekStart ?? process.env.QA_WEEK };
}

/** A signed-in Playwright page. `viewport`: "mobile" (390x844, default) | "desktop" (1366x900) | "WxH". */
export async function openAs(email, opts = {}) {
  await ensureDevServer();
  const out = opts.out ?? process.env.QA_OUT;
  const password = opts.password ?? passwordFor(email, out);
  const size = opts.viewport === "desktop" ? { width: 1366, height: 900 } : /^\d+x\d+$/.test(opts.viewport ?? "")
    ? { width: Number(opts.viewport.split("x")[0]), height: Number(opts.viewport.split("x")[1]) } : { width: 390, height: 844 };
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: UI_URL, viewport: size, locale: "he-IL", timezoneId: "Asia/Jerusalem" });
  const page = await context.newPage();
  await page.addInitScript(() => { try { window.localStorage.setItem("landing.lastMain", "/my"); } catch { /* ignore */ } });
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
  const { dept, week } = { ...scopeFrom(out), ...(opts.dept ? { dept: opts.dept } : {}), ...(opts.week ? { week: opts.week } : {}) };
  const urls = {
    board: (d = dept, w = week) => `/sadran/${d}/${w}/board`,
    publish: (d = dept, w = week) => `/sadran/${d}/${w}/publish`,
    proposals: (d = dept, w = week) => `/sadran/${d}/${w}/proposals`,
    siddur: (d = dept, w = week) => `/siddur/${d}/${w}`,
    my: () => "/my",
    inbox: () => "/inbox",
  };
  return { page, context, browser, urls, close: async () => { await browser.close(); } };
}

/**
 * Selects a day: the board's day strip shows only the weekday letter and a count, so the n-th
 * single-letter button (n = weekday, Sunday = 0) is clicked; if there is none, a button whose
 * label contains the date as `d.M` (the siddur's day headers). Best effort, returns whether it clicked.
 */
export async function selectDay(page, day) {
  const [year, month, date] = day.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  const letters = page.locator("button").filter({ hasText: /^\s*[\u05d0-\u05ea]['\u05f3]?\s*\d*\s*$/ });
  if ((await letters.count()) >= 7) { await letters.nth(weekday).click(); await page.waitForTimeout(800); return true; }
  const dated = page.locator('[role="tab"], button').filter({ hasText: new RegExp(`(^|\\D)${date}\\.${month}(\\D|$)`) }).first();
  if (await dated.count()) { await dated.click(); await page.waitForTimeout(800); return true; }
  return false;
}
