import { useMemo } from "react";

import { useDepartments } from "@/features/siddur/hooks";

/**
 * The home place ("בסיס", `departments.home_destination_id`) of every department the user can see, so the place
 * pickers can mark it and a member never picks a similarly named place by mistake (owner 2026-11-19). Place ids are
 * per department, so one set covers every department without knowing which one a picker belongs to.
 */
export function useHomePlaceIds(): ReadonlySet<string> {
  const departments = useDepartments();
  return useMemo(
    () => new Set((departments.data ?? []).map((d) => d.home_destination_id).filter((id): id is string => !!id)),
    [departments.data],
  );
}
