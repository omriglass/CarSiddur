// FC1 (owner 2026-11-14, REQ item 231): before a change that frees a shared car is confirmed, say what it will cause.
// The server tries the real action and rolls it back (`freed_car_preview`), returning the ranking input of each offer
// it would open; the browser ranks it with the same solver module as the on-ride-cancelled edge function
// (`runFreedSlot`, src/solver/freedSlotRun.ts), so the line matches what then happens. The line is left out when the
// answer takes longer than FREED_CAR_PREVIEW_BUDGET_MS (owner: 300–500 ms at most).
import { runFreedSlot, type FreedSlotOutcome, type FreedSlotRaw } from "@/solver";
import { he, tv } from "@/i18n/he";

import { previewFreedCar, type FreedCarPreviewRequest } from "./api";

export const FREED_CAR_PREVIEW_BUDGET_MS = 500;

/** "X", "X ו־Y", "X, Y ו־Z" (or "X, Y או Z"). */
export function joinFreedNames(names: readonly string[], conjunction: "and" | "or"): string {
  const list = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  if (list.length <= 1) return list[0] ?? "";
  const last = list[list.length - 1] ?? "";
  const rest = list.slice(0, -1).join(", ");
  return conjunction === "and" ? `${rest} ${he.freedCar.and}${last}` : `${rest} ${he.freedCar.or} ${last}`;
}

/** The line for one outcome (null = nobody waiting gets the car). */
export function freedCarOutcomeLine(outcome: FreedSlotOutcome): string | null {
  switch (outcome.kind) {
    case "auto":
      return outcome.name ? tv("freedCar.lineOne", { name: outcome.name }) : null;
    case "group":
      return outcome.names.length ? tv("freedCar.lineGroup", { names: joinFreedNames(outcome.names, "and") }) : null;
    case "sadran": {
      const names = [...new Set(outcome.names.filter(Boolean))];
      if (!names.length) return null;
      return names.length === 1
        ? tv("freedCar.lineSadranOne", { name: names[0] ?? "" })
        : tv("freedCar.lineSadran", { names: joinFreedNames(names, "or") });
    }
    default:
      return null;
  }
}

/** The lines for every offer the change would open (a ride shortened at both ends opens two), joined. */
export function freedCarLine(inputs: readonly unknown[]): string | null {
  const lines = inputs.map((raw) => freedCarOutcomeLine(runFreedSlot(raw as FreedSlotRaw).outcome)).filter((line): line is string => !!line);
  return lines.length ? [...new Set(lines)].join(" ") : null;
}

/** Ask the server, rank in the browser; null when nobody waiting would get the car, on any error, or past the budget. */
export async function fetchFreedCarLine(request: FreedCarPreviewRequest, budgetMs: number = FREED_CAR_PREVIEW_BUDGET_MS): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), budgetMs); });
  const answer = previewFreedCar(request).then((inputs) => freedCarLine(inputs)).catch(() => null);
  try {
    return await Promise.race([answer, late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
