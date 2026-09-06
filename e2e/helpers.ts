import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

// Stage 3 hardening (docs/UX_FLOWS.md §16 item 5): shared e2e utilities so
// each spec doesn't reinvent sign-in / service-role plumbing. Local-only
// Supabase stack (ARCHITECTURE.md §14) — the service-role key here is the
// fixed demo key `npx supabase status` always prints for a project using the
// default local `config.toml` JWT secret (same fallback `e2e/auth.spec.ts`
// already relies on), never a real secret and never used against a hosted
// project. Prefer the env var when set (`npx supabase status -o env` at
// runtime); nothing here is committed.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54321";
export const SUPABASE_ANON_KEY =
  process.env.VITE_SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
export const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

/** The four demo accounts `supabase/seed.sql` creates (email/password auth, local only). */
export const SEEDED_USERS = {
  admin: { email: "admin@nevo.local", password: "nevo-demo-1234", fullName: "אדמין נבו" },
  sadran: { email: "sadran@nevo.local", password: "nevo-demo-1234", fullName: "סדרן נבו" },
  member1: { email: "member1@nevo.local", password: "nevo-demo-1234", fullName: "חבר ראשון" },
  member2: { email: "member2@nevo.local", password: "nevo-demo-1234", fullName: "חברה שנייה" },
} as const;

export const NEVO_DEPARTMENT_ID = "00000000-0000-0000-0000-000000000001";

/** Same sign-in steps every spec's own inline `signIn()` already used (dev email/password form). */
export async function signIn(page: Page, user: { email: string; password: string }): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("אימייל").fill(user.email);
  await page.getByLabel("סיסמה").fill(user.password);
  await page.getByRole("button", { name: "התחברות", exact: true }).click();
  await expect(page).toHaveURL(/\/my$/);
}

/**
 * A fresh, independent browser context signed in as `user` — the robust way for a spec to
 * switch identity mid-test (a real multi-user flow, e.g. Sadran sends, a member answers).
 * `LoginPage.tsx` redirects straight to `/my` (or wherever `location.state.from` says)
 * whenever a session already exists, so reusing one `page` across two `signIn()` calls for
 * different users is unreliable — signing out first still leaves a `location.state.from`
 * from the just-abandoned route around to redirect back to post-login (Stage 3 hardening bug
 * found while writing e2e/proposal.spec.ts / e2e/freed-slot.spec.ts). Separate contexts also
 * more accurately model reality: two different people are two different sessions/devices.
 * Caller is responsible for `context.close()` (e.g. in a `finally` block).
 */
export async function newSignedInPage(
  browser: Browser,
  user: { email: string; password: string },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, user);
  return { context, page };
}

/** A fresh, unauthenticated service-role client — bypasses RLS entirely, test-setup/assertions only. */
export function serviceRoleClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** The department's current week_start for a given phase (there is exactly one of each in the seed). */
export async function getWeekStart(phase: "open" | "solving" | "published" | "live" | "archived"): Promise<string> {
  const client = serviceRoleClient();
  const { data, error } = await client
    .from("weeks")
    .select("week_start")
    .eq("department_id", NEVO_DEPARTMENT_ID)
    .eq("phase", phase)
    .order("week_start", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`no ${phase} week found for department ${NEVO_DEPARTMENT_ID}`);
  return data.week_start as string;
}

function readLocalCronSecret(): string | null {
  try {
    const envPath = path.resolve(__dirname, "../supabase/functions/.env");
    const content = fs.readFileSync(envPath, "utf8");
    const match = content.match(/^CRON_SECRET=(.*)$/m);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Wires `app_settings`/`app_secrets` so `cancel_ride()`'s pg_net call reaches the local edge
 * runtime, exactly like `supabase/functions/README.md`'s manual local-verification steps —
 * scripted here so `e2e/freed-slot.spec.ts` doesn't need a manual step first. Reads the local
 * `CRON_SECRET` straight out of the gitignored `supabase/functions/.env` (never committed,
 * never printed) so the value matches whatever the already-running edge runtime expects.
 * A no-op (skips the secret upsert) if that file doesn't exist — the freed-slot spec then
 * degrades to asserting only the parts that don't depend on the edge function round trip.
 */
export async function wireEdgeFunctionSettings(): Promise<{ cronSecretWired: boolean }> {
  const client = serviceRoleClient();
  const kongBase = "http://supabase_kong_carshare-nevo:8000/functions/v1";
  const { error: settingsError } = await client.from("app_settings").upsert(
    [
      { key: "on_ride_cancelled_url", value: { value: `${kongBase}/on-ride-cancelled` } },
      { key: "push_dispatch_url", value: { value: `${kongBase}/push-dispatch` } },
    ],
    { onConflict: "key" },
  );
  if (settingsError) throw settingsError;

  const secret = readLocalCronSecret();
  if (!secret) return { cronSecretWired: false };

  const { error: secretError } = await client
    .from("app_secrets")
    .upsert([{ key: "cron_secret", value: { value: secret } }], { onConflict: "key" });
  if (secretError) throw secretError;
  return { cronSecretWired: true };
}

/** Polls `check` until it returns true or `timeoutMs` elapses (async DB/pg_net side effects). */
export async function waitForCondition(
  check: () => Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) {
      throw new Error(options.message ?? `waitForCondition timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
