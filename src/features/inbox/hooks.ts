import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSession } from "@/features/auth/useSession";
import { showErrorToast } from "@/lib/rpc";

import {
  fetchNotifications,
  fetchUnreadNotificationCount,
  markAllNotificationsRead,
  markNotificationRead,
} from "./api";
import { inboxKeys } from "./queryKeys";

export function useNotifications() {
  const { session } = useSession();
  const profileId = session?.user.id;

  return useQuery({
    queryKey: inboxKeys.mine(profileId),
    queryFn: () => fetchNotifications(profileId as string),
    enabled: !!profileId,
    staleTime: 30_000,
  });
}

export function useMarkNotificationReadMutation() {
  const { session } = useSession();
  const profileId = session?.user.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: inboxKeys.mine(profileId) });
      queryClient.invalidateQueries({ queryKey: inboxKeys.unreadCount(profileId) });
    },
    onError: showErrorToast,
  });
}

export function useMarkAllNotificationsReadMutation() {
  const { session } = useSession();
  const profileId = session?.user.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => markAllNotificationsRead(profileId as string),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: inboxKeys.mine(profileId) });
      queryClient.invalidateQueries({ queryKey: inboxKeys.unreadCount(profileId) });
    },
    onError: showErrorToast,
  });
}

/** Unread notification count for the inbox tab badge (AppShell — a single hook import there). */
export function useUnreadCount() {
  const { session } = useSession();
  const profileId = session?.user.id;

  const query = useQuery({
    queryKey: inboxKeys.unreadCount(profileId),
    queryFn: () => fetchUnreadNotificationCount(profileId as string),
    enabled: !!profileId,
    staleTime: 15_000,
    refetchInterval: 60_000,
  });

  return query.data ?? 0;
}
