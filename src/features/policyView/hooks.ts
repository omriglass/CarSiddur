import { useQuery } from "@tanstack/react-query";

import { fetchDepartmentPolicies, fetchPolicyAlignment } from "./api";
import { policyViewKeys } from "./keys";

export function useDepartmentPoliciesQuery(departmentId: string | undefined) {
  return useQuery({
    queryKey: policyViewKeys.policies(departmentId ?? ""),
    queryFn: () => fetchDepartmentPolicies(departmentId as string),
    enabled: !!departmentId,
    staleTime: 10 * 60_000,
  });
}

export function usePolicyAlignmentQuery(policyId: string | undefined) {
  return useQuery({
    queryKey: policyViewKeys.alignment(policyId ?? ""),
    queryFn: () => fetchPolicyAlignment(policyId as string),
    enabled: !!policyId,
    staleTime: 10 * 60_000,
  });
}
