// Shared helpers for the QA week generator / regression (docs/QA_SIMULATION.md).
// Never imports from ../commucar-share. Local, disposable Supabase stacks only.

import { createClient } from "@supabase/supabase-js";

export const TZ = "Asia/Jerusalem";
export const DEFAULT_QA_API = "http://127.0.0.1:57321";
export const MEMBER_PASSWORD = "qa-member-1234";
export const ADMIN_EMAIL = "admin@nevo.local";
export const ADMIN_PASSWORD = "nevo-demo-1234";
export const SOURCE_DEPARTMENT_ID = "00000000-0000-0000-0000-000000000001";

// Standard local demo keys (identical for every local `supabase start`).
export const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
export const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

/**
 * Refuses anything but a local disposable stack. The owner's own stack (port 54321) is
 * refused outright; CI's database job runs the default stack, so it is allowed only when both
 * `CI=true` and `QA_ALLOW_DEFAULT_STACK=1` are set.
 */
export function resolveApi(apiArg) {
  const url = apiArg || process.env.QA_API_URL || DEFAULT_QA_API;
  const parsed = new URL(url);
  const host = parsed.hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`qa: refusing non-local API "${url}" (disposable local stacks only).`);
  }
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  if (port === "54321") {
    const ci = process.env.CI === "true" && process.env.QA_ALLOW_DEFAULT_STACK === "1";
    if (!ci) {
      throw new Error(
        "qa: refusing 127.0.0.1:54321 - that is the owner's local stack. Use a disposable stack (docs/QA_SIMULATION.md section 0). " +
          "(CI's database job is the only exception: CI=true and QA_ALLOW_DEFAULT_STACK=1.)",
      );
    }
  }
  return { url: url.replace(/\/$/, ""), anonKey: LOCAL_ANON_KEY, serviceKey: LOCAL_SERVICE_KEY };
}

export function serviceClient(api) {
  return createClient(api.url, api.serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

export async function signedInClient(api, email, password) {
  const client = createClient(api.url, api.anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`qa: sign-in failed for ${email}: ${error.message}`);
  return client;
}

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32)
// ---------------------------------------------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const randInt = (rng, min, max) => Math.floor(rng() * (max - min + 1)) + min;
export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
export const chance = (rng, p) => rng() < p;
export function weightedPick(rng, weights) {
  const total = weights.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [v, w] of weights) {
    if (r < w) return v;
    r -= w;
  }
  return weights[weights.length - 1][0];
}
export function shuffle(rng, arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geo
// ---------------------------------------------------------------------------
export function haversineKm(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/** Road distance estimate: haversine x 1.3 (same fallback the app's `place_travel()` uses). */
export const roadKm = (a, b) => Math.round(haversineKm(a, b) * 1.3 * 10) / 10;
export const roadMinutes = (km) => Math.max(5, Math.round((km / 55) * 60 + 3));

// ---------------------------------------------------------------------------
// Time (Asia/Jerusalem). No wall-clock Date getters: everything goes through Intl.
// ---------------------------------------------------------------------------
const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
export const jerusalemDate = (instant) => dateFmt.format(instant);

/** yyyy-MM-dd + n days (pure calendar arithmetic, UTC noon avoids DST edges). */
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
}
/** Day of week (0 = Sunday) of a yyyy-MM-dd calendar date. */
export function dowOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}
/** The Sunday strictly after "today" in Jerusalem (the next not-yet-started week). */
export function nextWeekStart(now = new Date()) {
  const today = jerusalemDate(now);
  return addDays(today, 7 - dowOf(today));
}

/** Offset (ms) of Asia/Jerusalem from UTC at a given UTC instant. */
function jerusalemOffsetMs(utcMs) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}
/** Jerusalem wall-clock (yyyy-MM-dd, minutes after midnight) -> ISO instant. */
export function toInstant(dateStr, minutes) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  let utc = guess - jerusalemOffsetMs(guess);
  utc = guess - jerusalemOffsetMs(utc);
  return new Date(utc).toISOString();
}
export const quarter = (minutes) => Math.floor(minutes / 15) * 15;

export function parseArgs(argv, spec) {
  const out = { ...spec };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (!(key in spec)) throw new Error(`qa: unknown argument ${a}`);
    out[key] = typeof spec[key] === "boolean" ? true : argv[++i];
  }
  return out;
}
