// Shared by the launcher, the Playwright helper and the TS CLIs: which Supabase stack the QA
// tooling talks to, and the hard refusal of the owner's local stack.
export const DISPOSABLE_API = "http://127.0.0.1:57321";
export const DISPOSABLE_DB_CONTAINER = "supabase_db_carshare-origins-test";
// The fixed demo anon key every local stack with the default JWT secret accepts (same as e2e/helpers.ts).
const DEMO_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const DEMO_SERVICE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

/** Throws unless `url` is a loopback API that is not the owner's stack (port 54321). */
export function assertDisposable(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`QA tooling: invalid API url ${url}`); }
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  if (port === "54321") {
    console.error("REFUSED: 127.0.0.1:54321 / localhost:54321 is the owner's own Supabase stack. QA tooling only runs on the disposable stack (default http://127.0.0.1:57321).");
    process.exit(3);
  }
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    console.error(`REFUSED: ${parsed.hostname} is not a local stack.`);
    process.exit(3);
  }
}

export function qaEnv() {
  const url = process.env.QA_API_URL ?? DISPOSABLE_API;
  return {
    VITE_SUPABASE_URL: url,
    VITE_SUPABASE_ANON_KEY: process.env.QA_ANON_KEY ?? DEMO_ANON,
    VITE_VAPID_PUBLIC_KEY: "qa-placeholder",
    VITE_APP_URL: "http://localhost:8092",
    QA_SERVICE_KEY: process.env.QA_SERVICE_KEY ?? DEMO_SERVICE,
  };
}
