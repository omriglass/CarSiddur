import { z } from "zod";

/**
 * Browser-side environment variables (ARCHITECTURE.md §13). Only `VITE_*`
 * variables reach the client; the service-role key and VAPID private key
 * never do. Validated once at import time so a missing/misconfigured
 * `.env.local` fails fast with a readable message instead of a runtime
 * `undefined` deep inside `supabase-js`.
 */
const envSchema = z.object({
  VITE_SUPABASE_URL: z.string().url(),
  VITE_SUPABASE_ANON_KEY: z.string().min(1),
  VITE_VAPID_PUBLIC_KEY: z.string().min(1),
  VITE_APP_URL: z.string().url(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Fallback values used only under Vitest (`import.meta.env.MODE === "test"`)
 * so unit tests never need a `.env.local`. Never used in `dev`/`build`.
 */
const testDefaults: Env = {
  VITE_SUPABASE_URL: "http://127.0.0.1:54321",
  VITE_SUPABASE_ANON_KEY: "test-anon-key",
  VITE_VAPID_PUBLIC_KEY: "test-vapid-public-key",
  VITE_APP_URL: "http://localhost:8080",
};

function loadEnv(): Env {
  const parsed = envSchema.safeParse(import.meta.env);
  if (parsed.success) {
    return parsed.data;
  }
  if (import.meta.env.MODE === "test") {
    return testDefaults;
  }
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(
    `Invalid environment configuration. Check .env.local against .env.example:\n${issues}`,
  );
}

export const env = loadEnv();
