import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchMyDepartments, setMyDefaultOrigin } from "./api";
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

/** "נקודת יציאה קבועה" (REQ §13.93, Profile page) — invalidates `useMyDepartments` so the new default shows immediately. */
export function useSetMyDefaultOriginMutation() {
  const { session } = useSession();
  const profileId = session?.user.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ departmentId, originId }: { departmentId: string; originId: string | null }) =>
      setMyDefaultOrigin(departmentId, originId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: authKeys.myDepartments(profileId) }),
  });
}
