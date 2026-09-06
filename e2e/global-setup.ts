import { execSync } from "node:child_process";

// Every spec assumes the exact state of supabase/seed.sql (one Open week, one
// Live week, four demo accounts). Specs mutate that state (publishing the Open
// week, accepting proposals, cancelling rides), so a second run against the
// same database fails on stale data. Reset before each run unless the caller
// opts out (useful when iterating on a single spec):  E2E_SKIP_RESET=1
export default function globalSetup(): void {
  if (process.env.E2E_SKIP_RESET === "1") {
    console.log("[e2e] E2E_SKIP_RESET=1 — using the database as-is");
    return;
  }
  console.log("[e2e] resetting local database to the seed state…");
  execSync("npx supabase db reset", { stdio: "inherit" });
}
