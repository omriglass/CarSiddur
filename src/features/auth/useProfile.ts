import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchProfile, updateProfile, type ProfilePatch } from "./api";
import { authKeys } from "./queryKeys";
import { useSession } from "./useSession";

interface UseProfileOptions {
  /** e.g. 30_000 on `/pending` (UX_FLOWS.md §3.1: poll every 30 s). */
  refetchInterval?: number;
}

/** The signed-in member's `profiles` row (approval_status, is_admin, phone, …). */
export function useProfile(options: UseProfileOptions = {}) {
  const { session } = useSession();
  const profileId = session?.user.id;

  return useQuery({
    queryKey: authKeys.profile(profileId),
    queryFn: () => fetchProfile(profileId as string),
    enabled: !!profileId,
    staleTime: 60_000,
    refetchInterval: options.refetchInterval,
  });
}

export function useUpdateProfileMutation() {
  const { session } = useSession();
  const profileId = session?.user.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (patch: ProfilePatch) => updateProfile(profileId as string, patch),
    onSuccess: (profile) => {
      queryClient.setQueryData(authKeys.profile(profileId), profile);
    },
  });
}
