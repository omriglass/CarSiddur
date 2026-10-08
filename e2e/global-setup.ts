import { execFileSync } from "node:child_process";

import { SEEDED_USERS, serviceRoleClient } from "./helpers";

// Every spec assumes the exact state of supabase/seed.sql (one Open week, one
// Live week, four demo accounts). Specs mutate that state (publishing the Open
// week, accepting proposals, cancelling rides), so a second run against the
// same database fails on stale data. Reset before each run unless the caller
// opts out (useful when iterating on a single spec):  E2E_SKIP_RESET=1
export default async function globalSetup(): Promise<void> {
  if (process.env.E2E_SKIP_RESET === "1") {
    console.log("[e2e] E2E_SKIP_RESET=1 — using the database as-is");
    await optSeededUsersIntoClassicForm();
    return;
  }
  const workdir = process.env.E2E_SUPABASE_WORKDIR;
  const api = process.env.VITE_SUPABASE_URL;
  if (api && !["http://127.0.0.1:54321", "http://localhost:54321"].includes(api) && !workdir) {
    throw new Error("An isolated E2E API requires E2E_SKIP_RESET=1 or E2E_SUPABASE_WORKDIR; refusing to reset the development database.");
  }
  console.log("[e2e] resetting local database to the seed state…");
  execFileSync("npx", ["supabase", "db", "reset", "--local", ...(workdir ? ["--workdir", workdir] : [])], { stdio: "inherit" });
  await optSeededUsersIntoClassicForm();
}

// REQ §13.110 (e): the sentence layout is the default request form, but most specs drive the
// classic field-by-field form (labels, radiogroups, `getByPlaceholder("לאן?")`), so every seeded
// account opts into it. `request-sentence.spec.ts` flips one account back for its own run.
async function optSeededUsersIntoClassicForm(): Promise<void> {
  const service = serviceRoleClient();
  const emails = Object.values(SEEDED_USERS).map((user) => user.email);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { error } = await service.from("profiles").update({ classic_request_form: true }).in("email", emails);
    if (!error) return;
    lastError = error;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw lastError;
}
