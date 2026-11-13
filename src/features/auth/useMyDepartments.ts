import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchMyDepartments, setMyDefaultOrigin, setMyPreferredCar } from "./api";
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

/** "רכב מועדף" (REQ item 224, Profile page) — invalidates `useMyDepartments` so new requests start with it at once. */
export function useSetMyPreferredCarMutation() {
  const { session } = useSession();
  const profileId = session?.user.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ departmentId, carId }: { departmentId: string; carId: string | null }) => setMyPreferredCar(departmentId, carId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: authKeys.myDepartments(profileId) }),
  });
}
