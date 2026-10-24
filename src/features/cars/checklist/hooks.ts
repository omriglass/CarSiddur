import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSession } from "@/features/auth/useSession";
import { showErrorToast } from "@/lib/rpc";

import {
  deleteChecklistItem,
  fetchCarChecklistStatus,
  fetchChecklistItems,
  fetchMyChecklistPrompts,
  moveChecklistItem,
  submitCarChecklist,
  upsertChecklistItem,
  type ChecklistAnswerInput,
} from "./api";
import { checklistKeys } from "./keys";

export function useChecklistItemsQuery(departmentId: string | undefined) {
  return useQuery({
    queryKey: checklistKeys.items(departmentId),
    queryFn: () => fetchChecklistItems(departmentId as string),
    enabled: !!departmentId,
    staleTime: 0,
  });
}

/** The car's latest checklist (green / not green as of its date), null when none. */
export function useCarChecklistStatusQuery(carId: string | undefined) {
  return useQuery({
    queryKey: checklistKeys.status(carId),
    queryFn: () => fetchCarChecklistStatus(carId as string),
    enabled: !!carId,
  });
}

/** Open "complete the handover checklist" prompts for me (new responsible person). */
export function useMyChecklistPromptsQuery() {
  const { session } = useSession();
  const profileId = session?.user.id;
  return useQuery({
    queryKey: checklistKeys.prompts(profileId),
    queryFn: () => fetchMyChecklistPrompts(profileId as string),
    enabled: !!profileId,
    staleTime: 60_000,
  });
}

export function useUpsertChecklistItemMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: upsertChecklistItem,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: checklistKeys.all }),
    onError: showErrorToast,
  });
}

export function useMoveChecklistItemMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, direction }: { itemId: string; direction: -1 | 1 }) => moveChecklistItem(itemId, direction),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: checklistKeys.all }),
    onError: showErrorToast,
  });
}

export function useDeleteChecklistItemMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteChecklistItem,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: checklistKeys.all }),
    onError: showErrorToast,
  });
}

export function useSubmitCarChecklistMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ carId, answers }: { carId: string; answers: ChecklistAnswerInput[] }) => submitCarChecklist(carId, answers),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: checklistKeys.all }),
    onError: showErrorToast,
  });
}
