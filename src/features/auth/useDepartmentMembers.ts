import { useQuery } from "@tanstack/react-query";

import { fetchDepartmentMembers } from "./api";
import { authKeys } from "./queryKeys";
import { useSession } from "./useSession";

/** Department members for `CompanionPicker` (request form), excluding myself. */
export function useDepartmentMembers(departmentId: string | undefined) {
  const { session } = useSession();
  const profileId = session?.user.id;

  return useQuery({
    queryKey: authKeys.departmentMembers(departmentId),
    queryFn: () => fetchDepartmentMembers(departmentId as string, profileId as string),
    enabled: !!departmentId && !!profileId,
    staleTime: 5 * 60_000,
  });
}
