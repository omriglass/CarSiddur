import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchNotificationTemplates,
  updateNotificationTemplate,
  type NotificationTemplateUpdate,
} from "./api";

const key = ["admin", "templates"] as const;

export function useNotificationTemplates() {
  return useQuery({ queryKey: key, queryFn: fetchNotificationTemplates, staleTime: 60_000 });
}

export function useUpdateNotificationTemplateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: NotificationTemplateUpdate }) => updateNotificationTemplate(id, patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
}
