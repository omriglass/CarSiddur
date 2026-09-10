import { rpc } from "@/lib/rpc";

import { departmentStatsSchema } from "./schema";

import type { DepartmentStats } from "./types";

/**
 * The only file in the `stats` feature that calls `.rpc()` (CLAUDE.md
 * Structure). `department_stats` returns a single `jsonb` value with no
 * generated row type, so the response is zod-parsed at this boundary before
 * it reaches any hook/component (mirrors `requests/api.ts`'s
 * `templateSuggestionRowSchema.parse`).
 */
export async function fetchDepartmentStats(
  departmentId: string,
  from: string,
  to: string,
): Promise<DepartmentStats> {
  const data = await rpc("department_stats", {
    p_department_id: departmentId,
    p_from: from,
    p_to: to,
  });
  return departmentStatsSchema.parse(data);
}
