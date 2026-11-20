import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSession } from "@/features/auth/useSession";

import { ackAskDisclaimer, adminSetAskAccess, fetchAskAccess, probeAsk, setMyAskHidden } from "./api";
import { askKeys } from "./keys";

/** The member's opt-in row (null = not opted in). */
export function useAskAccess(profileId?: string) {
  const { session } = useSession();
  const id = profileId ?? session?.user.id;
  return useQuery({ queryKey: askKeys.access(id), queryFn: () => fetchAskAccess(id as string), enabled: !!id, staleTime: 5 * 60_000 });
}

/** "+" offers the chat: opted in by an admin and not hidden in the profile. */
export function useAskOffered(): boolean {
  const access = useAskAccess();
  return !!access.data && !access.data.hidden;
}

/** Owner 2026-11-20: is the service usable (asked when the "+" sheet opens; kept for the session's next opens). */
export function useAskProbe(enabled: boolean) {
  return useQuery({ queryKey: askKeys.probe(), queryFn: probeAsk, enabled, staleTime: 5 * 60_000, retry: false });
}

export function useSetMyAskHiddenMutation() {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: setMyAskHidden, onSettled: () => queryClient.invalidateQueries({ queryKey: askKeys.all }) });
}

export function useAckAskDisclaimerMutation() {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: ackAskDisclaimer, onSettled: () => queryClient.invalidateQueries({ queryKey: askKeys.all }) });
}

export function useAdminSetAskAccessMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ profileId, enabled }: { profileId: string; enabled: boolean }) => adminSetAskAccess(profileId, enabled),
    onSettled: () => queryClient.invalidateQueries({ queryKey: askKeys.all }),
  });
}
