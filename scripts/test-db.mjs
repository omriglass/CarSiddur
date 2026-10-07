import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const config = readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");
const projectId = /^project_id\s*=\s*"([^"]+)"/m.exec(config)?.[1];
if (!projectId) throw new Error("Missing Supabase project_id");
const container = process.env.SUPABASE_DB_CONTAINER ?? `supabase_db_${projectId}`;
for (const file of ["rls_smoke.sql", "admin_member_fixes.sql", "solve_semantics.sql", "todo_board_semantics.sql", "one_way_lifecycle.sql", "proposal_replacement.sql", "live_quick_one_way.sql", "selected_day_publication.sql", "coordinator_planning.sql", "proposal_day_boundary.sql", "status_notifications.sql", "week_opening.sql", "weekly_sadran_permissions.sql", "admin_department_membership.sql", "member_identity.sql", "department_catalogs.sql", "notifications_semantics.sql", "car_care_semantics.sql", "waitlist_groups.sql", "request_templates.sql", "multi_day_series.sql", "upcoming_weeks.sql", "department_stats.sql", "hardening_semantics.sql", "car_mileage.sql", "ride_passengers.sql", "joinable_rides.sql", "car_chain_healing.sql", "withdraw_settles.sql", "day_car_swap.sql", "department_isolation.sql", "origins_schema.sql", "origins_chain.sql", "multi_stop.sql", "board_drafts.sql", "merged_rides.sql", "trip_type_change.sql", "reservations_neutral.sql", "publication_car_location.sql", "freed_slot_external.sql", "qa_run1_cancel_waitlist.sql", "placement_features.sql", "proposals_copy_and_series_span.sql", "qa_run2_placement.sql", "qa_run3_placement.sql", "qa_run2_proposals.sql", "qa_run3_proposals.sql", "qa_run4_proposals.sql", "qa_run5_cancel.sql", "qa_run5_publish.sql", "qa_run5_placement.sql", "qa_run5_proposals.sql"]) {
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

// Extended test, opt-in (docs/QA_SIMULATION.md §5): generate the seeded QA week, solve it with the
// real solver, apply it and check the invariants. Needs QA_API_URL pointing at the stack whose DB
// container is selected above (never the owner's local stack: scripts/qa/qa-common.mjs refuses :54321
// unless CI=true and QA_ALLOW_DEFAULT_STACK=1, which only CI's database job sets).
if (process.env.QA_REGRESSION === "1") {
  if (!process.env.QA_API_URL) throw new Error("QA_REGRESSION=1 needs QA_API_URL (the API of the stack behind SUPABASE_DB_CONTAINER)");
  console.log("Extended checks: QA week regression (seeded week -> real solver -> apply_solver_result -> invariants)");
  execFileSync(process.execPath, [new URL("./qa/regression.mjs", import.meta.url).pathname], {
    env: { ...process.env, SUPABASE_DB_CONTAINER: container },
    stdio: "inherit",
  });
}

// API-level suite, opt-in locally, always on in CI's database job (docs/TODO.md U1/U1a): real RPCs as signed-in
// seeded users through PostgREST (catches failures the owner-run SQL suites cannot: RLS, grants, unqualified writes
// such as R5B1's DELETE). Covers: cancel_ride (passenger/chauffeur/driver/stranger); submit_request -> edit with
// expected_version -> withdraw_request; Sadran create_proposal (merge, shift) -> send_proposal -> members
// answer_proposal in-app -> applied; publish_siddur then a plain member reads the rides (RLS); member
// add_ride_passengers/remove_ride_person and swap_day_cars; Sadran mark_car_move and set_ride_driver; freed slot
// (cancel_ride -> resolve_freed_offer -> claim_freed_slot -> approve_claim, and the lone-candidate auto assign);
// submit_series_request -> shorten_series; plus per-role negatives (a member cannot publish, propose, send, approve,
// move a car or assign a driver). Needs QA_API_URL, the API of the stack behind SUPABASE_DB_CONTAINER.
if (process.env.QA_API === "1") {
  if (!process.env.QA_API_URL) throw new Error("QA_API=1 needs QA_API_URL (the API of the stack behind SUPABASE_DB_CONTAINER)");
  console.log("API checks: scripts/test-api.mjs (main flows as signed-in members and Sadran: requests, proposals, publish, rides, freed slot, series)");
  execFileSync(process.execPath, [new URL("./test-api.mjs", import.meta.url).pathname], { stdio: "inherit" });
}
