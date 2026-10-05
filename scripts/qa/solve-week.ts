// Solves the QA week with the REAL solver and applies it as the QA Sadran, exactly like the board's
// "solve" action (gatherSolverContext -> solve() -> buildApplyPayload -> apply_solver_result).
// Run through scripts/qa/regression.mjs (vite-node with scripts/qa/vite.config.ts, which only maps the
// `@` alias and never reads the owner's .env.local). Never touches the owner's stack: the launcher
// has already refused port 54321, and this file checks again.
//
//   QA_WORLD=<out>/world.json QA_SOLVE_OUT=<file.json> vite-node scripts/qa/solve-week.ts

import { readFileSync, writeFileSync } from "node:fs";

import * as api from "@/features/sadran/api";
import {
  applySolverResult,
} from "@/features/sadran/api";
import { buildApplyPayload, gatherSolverContext, hashSolverInput, nowMs, runSolve } from "@/features/sadran/applySolve";
import { supabase } from "@/integrations/supabase/client";

import type { Json } from "@/integrations/supabase/types";

interface World {
  department: { id: string; homePlaceId: string };
  weekStart: string;
  sadran: { email: string; password: string };
}

async function main(): Promise<void> {
  const url = String(import.meta.env.VITE_SUPABASE_URL);
  if (new URL(url).port === "54321" && !(process.env.CI === "true" && process.env.QA_ALLOW_DEFAULT_STACK === "1")) {
    throw new Error("solve-week: refusing the owner's stack (port 54321)");
  }
  const worldPath = process.env.QA_WORLD;
  const outPath = process.env.QA_SOLVE_OUT;
  if (!worldPath || !outPath) throw new Error("solve-week: QA_WORLD and QA_SOLVE_OUT are required");
  const world = JSON.parse(readFileSync(worldPath, "utf8")) as World;

  const signIn = await supabase.auth.signInWithPassword({ email: world.sadran.email, password: world.sadran.password });
  if (signIn.error) throw new Error(`solve-week: Sadran sign-in failed: ${signIn.error.message}`);

  const policy = await api.fetchActivePolicy(world.department.id);
  if (!policy) throw new Error("solve-week: the QA department has no active policy");

  const context = await gatherSolverContext({
    departmentId: world.department.id,
    weekStart: world.weekStart,
    homeDestinationId: world.department.homePlaceId,
    policy: {
      policyId: policy.policyId,
      policyVersionId: policy.policyVersionId,
      versionNo: policy.versionNo,
      rules: policy.rules,
      settings: policy.settings,
    },
    mode: "full",
  });
  const startedAtMs = nowMs();
  // A solver exception is itself a finding. Record it, then degrade step by step so the rest of the
  // regression (apply + invariants) still has data to check: (1) without the improvement pass,
  // (2) additionally giving each temporary car the base the SQL side uses (the owner's default
  // origin = its start location) which the bridge does not map.
  const crashes: string[] = [];
  const attempts: Array<(input: typeof context.input) => typeof context.input> = [
    (input) => input,
    (input) => ({ ...input, config: { ...input.config, improvementBudget: 0 } }),
    (input) => ({
      ...input,
      config: { ...input.config, improvementBudget: 0 },
      cars: input.cars.map((car) => (car.type === "temporary" ? { ...car, baseLocationId: car.startLocationId ?? car.baseLocationId } : car)),
    }),
  ];
  let output: ReturnType<typeof runSolve> | null = null;
  for (const [index, degrade] of attempts.entries()) {
    try {
      output = runSolve(degrade(context.input));
      break;
    } catch (error) {
      const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
      crashes.push(`attempt ${index}: ${text.split("\n").slice(0, 3).join(" | ")}`);
      console.error(`solve-week: SOLVER CRASH on attempt ${index}\n${text}`);
    }
  }
  if (!output) throw new Error(`solve-week: the solver crashed on every attempt: ${crashes.join(" || ")}`);
  const solverCrash = crashes.length ? crashes.join(" || ") : null;
  const finishedAtMs = nowMs();
  const payload = buildApplyPayload({
    output,
    weekStartMs: context.weekStartMs,
    policyVersionId: context.policyVersionId,
    startedAtMs,
    finishedAtMs,
    inputHash: hashSolverInput(context.input),
    requestsById: context.requestsById,
    mode: "full",
  });

  let applied: unknown = null;
  let applyError: string | null = null;
  try {
    applied = await applySolverResult(world.department.id, world.weekStart, payload as unknown as Json);
  } catch (error) {
    applyError = error instanceof Error ? error.message : JSON.stringify(error);
  }

  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        requestsInSolve: context.input.requests.length,
        assignments: output.assignments.filter((a) => a.source === "solver").length,
        stats: output.stats,
        warnings: output.warnings ?? [],
        unmet: output.unmet.map((u) => ({ requestId: u.requestId, reasonCode: u.reasonCode, reason: u.reason })),
        solverCrash,
        applied,
        applyError,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`solve-week: ${output.stats.served} served, ${output.stats.unmet} unmet${applyError ? `, APPLY FAILED: ${applyError}` : ""}`);
  if (applyError) process.exitCode = 4;
}

main().catch((error: unknown) => {
  console.error(`solve-week: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
