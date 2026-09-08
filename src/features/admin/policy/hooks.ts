import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createPolicy,
  createPolicyVersion,
  fetchPolicies,
  fetchPolicyVersions,
  setPolicyActive,
  type PolicyRuleConfig,
} from "./api";

const policyKeys = {
  all: ["admin", "policies"] as const,
  list: () => [...policyKeys.all, "list"] as const,
  versions: (policyId: string | undefined) => [...policyKeys.all, "versions", policyId] as const,
};

export function usePoliciesAdmin() {
  const { departmentId } = useActiveDepartment();
  return useQuery({ queryKey: [...policyKeys.list(), departmentId], enabled: !!departmentId, queryFn: () => fetchPolicies(departmentId as string), staleTime: 60_000 });
}

export function usePolicyVersions(policyId: string | undefined) {
  return useQuery({
    queryKey: policyKeys.versions(policyId),
    queryFn: () => fetchPolicyVersions(policyId as string),
    enabled: !!policyId,
  });
}

export function useCreatePolicyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; department_id: string }) => createPolicy(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: policyKeys.list() }),
  });
}

export function useCreatePolicyVersionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ policyId, rules, note }: { policyId: string; rules: PolicyRuleConfig[]; note: string | null }) =>
      createPolicyVersion(policyId, rules, note),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: policyKeys.versions(variables.policyId) });
      void queryClient.invalidateQueries({ queryKey: policyKeys.list() });
    },
  });
}

export function useSetPolicyActiveMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ policyId, isActive }: { policyId: string; isActive: boolean }) => setPolicyActive(policyId, isActive),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: policyKeys.list() }),
  });
}
