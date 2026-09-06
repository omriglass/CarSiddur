import { useQuery } from "@tanstack/react-query";

import { fetchMyDepartments } from "./api";
import { authKeys } from "./queryKeys";
import { useSession } from "./useSession";

/** My active `department_members` rows, joined to `departments` for display. */
export function useMyDepartments() {
  const { session } = useSession();
  const profileId = session?.user.id;

  return useQuery({
    queryKey: authKeys.myDepartments(profileId),
    queryFn: () => fetchMyDepartments(profileId as string),
    enabled: !!profileId,
    staleTime: 5 * 60_000,
  });
}
