// scripts/replay/explain.ts — every request's priority score, rule by rule, as the solver computes
// it for the week loaded on the replay stack (read-only: nothing is solved or applied).
//
//   npm run replay:explain -- --out .replay/out/<dept>-<week> [--json <file>]
//
// Signs in as the week's Sadran from <out>/world.json, builds the solver input exactly like the
// board (gatherSolverContext) and runs the policy engine on it. Prints one line per request, highest
// score first: score, each rule's 0..1 value, the facts behind them, and the request's status now.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as api from "@/features/sadran/api";
import { gatherSolverContext } from "@/features/sadran/applySolve";
import { supabase } from "@/integrations/supabase/client";
import { scoreRequests } from "@/solver/policy/engine";
import { normalize } from "@/solver/slots";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

async function main(): Promise<void> {
  const url = String(import.meta.env.VITE_SUPABASE_URL);
  if (new URL(url).port !== "56321") throw new Error(`explain: only runs against the replay stack (56321), not ${url}`);
  const out = path.resolve(flag("out") ?? "");
  const world = JSON.parse(readFileSync(path.join(out, "world.json"), "utf8")) as {
    department: { id: string; homePlaceId: string }; weekStart: string; sadran: { email: string; password: string };
  };
  const signIn = await supabase.auth.signInWithPassword({ email: world.sadran.email, password: world.sadran.password });
  if (signIn.error) throw new Error(`explain: sign-in failed: ${signIn.error.message}`);

  const policy = await api.fetchActivePolicy(world.department.id);
  if (!policy) throw new Error("explain: no active policy");
  const context = await gatherSolverContext({
    departmentId: world.department.id,
    weekStart: world.weekStart,
    homeDestinationId: world.department.homePlaceId,
    policy: { policyId: policy.policyId, policyVersionId: policy.policyVersionId, versionNo: policy.versionNo, rules: policy.rules, settings: policy.settings },
    mode: "full",
    forScoring: true,
  });
  const input = context.input;
  const { normalized, seriesUnits } = normalize(input);
  const batch = [...normalized, ...seriesUnits.map((su) => su.scoreProxy)];
  const { scores } = scoreRequests(input, batch);

  const rows = batch.map((nr) => {
    const r = nr.request;
    const dest = input.destinations[r.destinationId];
    const breakdown = scores.get(nr.id);
    const row = context.requestsById.get(r.id.split("#")[0] ?? r.id);
    return {
      id: r.id,
      who: r.memberName ?? r.memberId.slice(0, 8),
      when: r.departureMs ? clock.format(new Date(r.departureMs)) : r.returnMs ? clock.format(new Date(r.returnMs)) : "?",
      destination: dest?.name ?? r.destinationText ?? "?",
      rideType: r.rideType,
      tripType: r.tripType ?? "",
      km: dest?.distanceKm ?? null,
      pt: dest?.publicTransportScore ?? null,
      people: nr.passengers.adults + nr.passengers.childSeats + nr.passengers.boosters,
      fallback: r.fallback ?? "",
      status: row?.status ?? "?",
      score: breakdown?.total ?? 0,
      rules: Object.fromEntries((breakdown?.perRule ?? []).map((p) => [p.type, Math.round(p.normalized * 100) / 100])),
    };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  console.log(`policy ${policy.versionNo}: ${input.policy.rules.map((r) => `${r.type}×${r.weight}`).join(", ")} (carChoice ${input.policy.carChoice ?? "spread"})`);
  for (const x of rows) {
    const rules = Object.entries(x.rules).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`${x.score.toFixed(2).padStart(6)}  ${x.status.padEnd(10)} ${x.when}  ${x.who} -> ${x.destination} [${x.rideType}, ${x.tripType}${x.fallback ? `, ${x.fallback}` : ""}] km=${x.km ?? "?"} pt=${x.pt ?? "?"} people=${x.people}  ${rules}`);
  }
  const json = flag("json");
  if (json) writeFileSync(path.resolve(json), JSON.stringify(rows, null, 2));
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
