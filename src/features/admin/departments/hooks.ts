import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createDepartment,
  fetchDepartmentCounts,
  fetchDepartments,
  fetchDepartmentSettings,
  updateDepartment,
  updateDepartmentSettings,
  type DepartmentInsert,
  type DepartmentSettingsUpdate,
  type DepartmentUpdate,
} from "./api";
import { departmentAdminKeys } from "./queryKeys";

export function useDepartmentsAdmin() {
  return useQuery({ queryKey: departmentAdminKeys.list(), queryFn: fetchDepartments, staleTime: 60_000 });
}

export function useDepartmentCounts() {
  return useQuery({ queryKey: departmentAdminKeys.counts(), queryFn: fetchDepartmentCounts, staleTime: 60_000 });
}

export function useDepartmentSettings(departmentId: string | undefined) {
  return useQuery({
    queryKey: departmentAdminKeys.settings(departmentId),
    queryFn: () => fetchDepartmentSettings(departmentId as string),
    enabled: !!departmentId,
  });
}

export function useCreateDepartmentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: DepartmentInsert & { source_department_id?: string }) => createDepartment(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: departmentAdminKeys.list() });
      void queryClient.invalidateQueries({ queryKey: ["context"] });
      void queryClient.invalidateQueries({ queryKey: ["siddur", "departments"] });
      void queryClient.invalidateQueries({ queryKey: departmentAdminKeys.counts() });
    },
  });
}

export function useUpdateDepartmentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: DepartmentUpdate }) => updateDepartment(id, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: departmentAdminKeys.list() });
      void queryClient.invalidateQueries({ queryKey: ["context"] });
      void queryClient.invalidateQueries({ queryKey: ["siddur", "departments"] });
    },
  });
}

export function useUpdateDepartmentSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ departmentId, patch }: { departmentId: string; patch: DepartmentSettingsUpdate }) =>
      updateDepartmentSettings(departmentId, patch),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: departmentAdminKeys.settings(variables.departmentId) });
    },
  });
}
