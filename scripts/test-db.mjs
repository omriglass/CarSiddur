import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const config = readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");
const projectId = /^project_id\s*=\s*"([^"]+)"/m.exec(config)?.[1];
if (!projectId) throw new Error("Missing Supabase project_id");
const container = process.env.SUPABASE_DB_CONTAINER ?? `supabase_db_${projectId}`;
for (const file of ["rls_smoke.sql", "admin_member_fixes.sql", "solve_semantics.sql", "todo_board_semantics.sql", "one_way_lifecycle.sql", "proposal_replacement.sql", "live_quick_one_way.sql", "selected_day_publication.sql", "coordinator_planning.sql", "proposal_day_boundary.sql", "status_notifications.sql", "week_opening.sql", "weekly_sadran_permissions.sql", "admin_department_membership.sql", "member_identity.sql", "department_catalogs.sql", "notifications_semantics.sql", "car_care_semantics.sql", "waitlist_groups.sql", "request_templates.sql", "multi_day_series.sql", "upcoming_weeks.sql", "department_stats.sql", "hardening_semantics.sql", "car_mileage.sql", "ride_passengers.sql", "joinable_rides.sql", "car_chain_healing.sql", "withdraw_settles.sql", "day_car_swap.sql", "department_isolation.sql"]) {
  console.log(`Database checks: ${file}`);
  execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"], {
    input: readFileSync(new URL(`../supabase/tests/${file}`, import.meta.url)),
    stdio: ["pipe", "inherit", "inherit"],
  });
}

// One-way relay-pair-vs-chauffeur parity golden cases (docs/TODO.md "Code review
// 2026-09-24" R11): exercises pair_one_way_legs()/assert_car_chain against a real
// database, checked against the same fixture the TS solver's own parity test uses
// (src/solver/__tests__/oneWayPairingParity.test.ts). Not one of the transactional
// SQL suites above (it builds and runs its own script, and reports SKIP for cases
// with a recorded knownDivergence instead of failing the whole run).
console.log("Database checks: pairing parity (one-way relay vs chauffeur)");
execFileSync(process.execPath, [new URL("./test-pairing-parity.mjs", import.meta.url).pathname], {
  env: { ...process.env, SUPABASE_DB_CONTAINER: container },
  stdio: "inherit",
});
