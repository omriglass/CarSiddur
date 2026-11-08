import { useQuery } from "@tanstack/react-query";

import { useSession } from "@/features/auth/useSession";
import { fetchGuardedChildren } from "./api";
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
