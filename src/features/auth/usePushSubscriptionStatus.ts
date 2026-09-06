import { useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchMyPushSubscriptionCount } from "./api";
import { authKeys } from "./queryKeys";
import { useSession } from "./useSession";

/** Whether the signed-in member has a registered push subscription (Profile push toggle). */
export function usePushSubscriptionStatus() {
  const { session } = useSession();
  const profileId = session?.user.id;
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: authKeys.pushSubscriptionCount(profileId),
    queryFn: () => fetchMyPushSubscriptionCount(profileId as string),
    enabled: !!profileId,
    staleTime: 60_000,
  });

  return {
    isSubscribed: (query.data ?? 0) > 0,
    isLoading: query.isLoading,
    refresh: () => queryClient.invalidateQueries({ queryKey: authKeys.pushSubscriptionCount(profileId) }),
  };
}
