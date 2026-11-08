#!/usr/bin/env node
// scripts/perf/count-calls.mjs — how many API calls one screen open makes (TODO PF1).
//
// Signs in on a LOCAL app (default the debug copy of production, `npm run debug -- app` on :6073), opens each
// path, and counts every request to the API for `--wait` seconds after the page settles: PostgREST tables/views,
// RPCs, auth, and Realtime channel joins. Never points at production.
//
//   node scripts/perf/count-calls.mjs --email p-c0b034c5@debug.local --path /sadran/<dept>/<week>/board [--path …]
//        [--app http://localhost:6073] [--password debug-local-1234] [--wait 20]
import { chromium } from "@playwright/test";

function args(name) {
  const out = [];
  process.argv.forEach((a, i) => { if (a === `--${name}`) out.push(process.argv[i + 1]); });
  return out;
}
const app = args("app")[0] ?? "http://localhost:6073";
const email = args("email")[0];
const password = args("password")[0] ?? "debug-local-1234";
const paths = args("path");
const waitMs = Number(args("wait")[0] ?? "20") * 1000;
if (!email || paths.length === 0) {
  console.error("usage: count-calls.mjs --email <local login> --path <app path> [--path …] [--app <url>] [--wait <s>]");
  process.exit(1);
}
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(app)) {
  console.error("count-calls: local apps only");
  process.exit(1);
}

function endpoint(url) {
  const u = new URL(url);
  const rest = u.pathname.match(/\/rest\/v1\/(rpc\/)?([^/?]+)/);
  if (rest) return `${rest[1] ? "rpc" : "table"} ${rest[2]}`;
  if (u.pathname.includes("/auth/v1/")) return `auth ${u.pathname.split("/auth/v1/")[1]}`;
  if (u.pathname.includes("/realtime/")) return "realtime";
  return null;
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
let counts = new Map();
let joins = 0;
page.on("request", (req) => {
  const e = endpoint(req.url());
  if (e) counts.set(e, (counts.get(e) ?? 0) + 1);
});
page.on("websocket", (ws) => {
  ws.on("framesent", (f) => { if (typeof f.payload === "string" && f.payload.includes('"phx_join"')) joins += 1; });
});

await page.goto(`${app}/login`);
await page.locator('input[type="email"]').fill(email);
await page.locator('input[type="password"]').fill(password);
await page.locator('button[type="submit"]').first().click();
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
await page.waitForLoadState("networkidle").catch(() => {});

for (const path of paths) {
  counts = new Map();
  joins = 0;
  const started = Date.now();
  await page.goto(`${app}${path}`);
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  const settledMs = Date.now() - started;
  await page.waitForTimeout(waitMs);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  console.log(`\n${path}  — ${total} API calls, ${joins} realtime joins (settled in ${(settledMs / 1000).toFixed(1)} s, then ${waitMs / 1000} s idle)`);
  for (const [e, n] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    console.log(`  ${String(n).padStart(4)}  ${e}`);
  }
}
await browser.close();
