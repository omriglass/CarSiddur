import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showErrorToast } from "@/lib/rpc";

import {
  deleteCarGuide,
  deleteGuideTopic,
  fetchCarGuides,
  fetchCarIdsWithGuides,
  fetchDepartmentGuides,
  fetchGuideTopics,
  fetchMissingGuides,
  moveGuideTopic,
  saveCarGuide,
  upsertGuideTopic,
} from "./api";
import { guideKeys } from "./keys";

export function useGuideTopicsQuery(departmentId: string | undefined) {
  return useQuery({
    queryKey: guideKeys.topics(departmentId),
    queryFn: () => fetchGuideTopics(departmentId as string),
    enabled: !!departmentId,
    staleTime: 60_000,
  });
}

export function useCarGuidesQuery(carId: string | undefined) {
  return useQuery({ queryKey: guideKeys.car(carId), queryFn: () => fetchCarGuides(carId as string), enabled: !!carId });
}

export function useDepartmentGuidesQuery(departmentId: string | undefined) {
  return useQuery({
    queryKey: guideKeys.department(departmentId),
    queryFn: () => fetchDepartmentGuides(departmentId as string),
    enabled: !!departmentId,
    staleTime: 5 * 60_000,
  });
}

/** The ids of these cars that have guides (a Set). */
export function useCarsWithGuidesQuery(carIds: readonly string[]) {
  return useQuery({
    queryKey: guideKeys.withGuides(carIds),
    queryFn: () => fetchCarIdsWithGuides(carIds),
    enabled: carIds.length > 0,
    staleTime: 5 * 60_000,
    select: (ids) => new Set(ids),
  });
}

export function useMissingGuidesQuery(departmentId: string | undefined) {
  return useQuery({
    queryKey: guideKeys.missing(departmentId),
    queryFn: () => fetchMissingGuides(departmentId as string),
    enabled: !!departmentId,
    staleTime: 60_000,
  });
}

function useGuideMutation<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: guideKeys.all }),
    onError: showErrorToast,
  });
}

export const useUpsertGuideTopicMutation = () => useGuideMutation(upsertGuideTopic);
export const useMoveGuideTopicMutation = () =>
  useGuideMutation(({ topicId, direction }: { topicId: string; direction: -1 | 1 }) => moveGuideTopic(topicId, direction));
export const useDeleteGuideTopicMutation = () => useGuideMutation(deleteGuideTopic);
export const useSaveCarGuideMutation = () => useGuideMutation(saveCarGuide);
export const useDeleteCarGuideMutation = () => useGuideMutation(deleteCarGuide);
