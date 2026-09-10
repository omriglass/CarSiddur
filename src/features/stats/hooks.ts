import { useQuery } from "@tanstack/react-query";

import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useMyDepartments } from "@/features/auth/useMyDepartments";
import { useProfile } from "@/features/auth/useProfile";

import { fetchDepartmentStats } from "./api";
import { statsKeys } from "./keys";

/** Department/week-scoped query for `department_stats` (CLAUDE.md "Data": TanStack Query only). */
export function useDepartmentStatsQuery(departmentId: string | undefined, from: string, to: string) {
  return useQuery({
    queryKey: statsKeys.department(departmentId ?? "", from, to),
    queryFn: () => fetchDepartmentStats(departmentId as string, from, to),
    enabled: !!departmentId && !!from && !!to,
    staleTime: 60_000,
  });
}

export interface StatsDepartmentOption {
  id: string;
  name: string;
}

/**
 * Departments the signed-in user may view statistics for (UX_FLOWS.md §5.12
 * "admins and Sadranim"): a global admin sees every active department; a
 * non-admin sees the departments where their permanent `department_members`
 * role is `sadran`/`admin` (a weekly-only Sadran assignment doesn't grant
 * this — there is no single week to check it against here). This is UI
 * convenience only, same as every other role gate; the RPC itself is the
 * real guarantee (CLAUDE.md Conventions "Roles").
 */
export function useStatsDepartments() {
  const profileQuery = useProfile();
  const membershipsQuery = useMyDepartments();
  const activeDepartment = useActiveDepartment();
  const isAdmin = !!profileQuery.data?.is_admin;

  const options: StatsDepartmentOption[] = isAdmin
    ? activeDepartment.departments.map((department) => ({ id: department.id, name: department.name }))
    : (membershipsQuery.data ?? [])
        .filter((membership) => membership.role === "sadran" || membership.role === "admin")
        .map((membership) => ({ id: membership.department_id, name: membership.department.name }));

  return {
    options,
    isAdmin,
    isLoading: profileQuery.isLoading || membershipsQuery.isLoading || (isAdmin && activeDepartment.isLoading),
  };
}

/** Whether the signed-in user may view `departmentId`'s statistics screen. */
export function useCanViewDepartmentStats(departmentId: string | undefined) {
  const { options, isAdmin, isLoading } = useStatsDepartments();
  const allowed = !!departmentId && (isAdmin || options.some((option) => option.id === departmentId));
  return { allowed, isLoading, options, isAdmin };
}
