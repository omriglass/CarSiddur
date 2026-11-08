import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSession } from "@/features/auth/useSession";
import { showErrorToast } from "@/lib/rpc";
import { fetchGuardedChildren, fetchRideEditors, setRideEditors } from "./api";
import { memberKeys } from "./keys";

export function useGuardedChildrenQuery() {
  const { session } = useSession();
  const profileId = session?.user.id;
  return useQuery({
    queryKey: memberKeys.guardedChildren(profileId),
    queryFn: () => fetchGuardedChildren(profileId as string),
    enabled: !!profileId,
    staleTime: 5 * 60_000,
  });
}

/** REQ §13.202: whom I let edit my rides, and who lets me edit theirs. */
export function useRideEditorsQuery() {
  const { session } = useSession();
  const profileId = session?.user.id;
  return useQuery({
    queryKey: memberKeys.rideEditors(profileId),
    queryFn: () => fetchRideEditors(profileId as string),
    enabled: !!profileId,
  });
}

export function useSetRideEditorsMutation() {
  const queryClient = useQueryClient();
  const { session } = useSession();
  return useMutation({
    mutationFn: ({ departmentId, editorIds }: { departmentId: string; editorIds: readonly string[] }) => setRideEditors(departmentId, editorIds),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: memberKeys.rideEditors(session?.user.id) }),
    onError: showErrorToast,
  });
}
