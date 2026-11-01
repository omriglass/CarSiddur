import { useQuery } from "@tanstack/react-query";

import { fetchDepartmentMembers } from "./api";
import { authKeys } from "./queryKeys";
import { useSession } from "./useSession";

/**
 * Department members for `CompanionPicker` (request form), excluding myself; `includeSelf` for the Sadran's pickers
 * (a ride's driver, a reservation's people), where the Sadran is a member like any other.
 */
export function useDepartmentMembers(departmentId: string | undefined, { includeSelf = false }: { includeSelf?: boolean } = {}) {
  const { session } = useSession();
  const profileId = session?.user.id;

  return useQuery({
    queryKey: authKeys.departmentMembers(departmentId, includeSelf),
    queryFn: () => fetchDepartmentMembers(departmentId as string, includeSelf ? null : (profileId as string)),
    enabled: !!departmentId && !!profileId,
  });
}
