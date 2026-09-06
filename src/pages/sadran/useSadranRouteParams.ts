import { useParams } from "react-router-dom";

import { useIsSadran } from "@/features/auth/useIsSadran";

/**
 * Reads `:dept`/`:week` from the URL and checks I'm actually Sadran of that
 * specific department/week (`RequireSadran` in `guards.tsx` only checks "of
 * anything, anywhere" — UX_FLOWS.md §2.1 route table calls for the
 * finer-grained check on every `/sadran/:dept/:week*` page).
 */
export function useSadranRouteParams() {
  const params = useParams<{ dept: string; week: string }>();
  const departmentId = params.dept as string;
  const weekStart = params.week as string;
  const { isSadran, isLoading } = useIsSadran(departmentId, weekStart);
  return { departmentId, weekStart, isSadran, isLoading };
}
