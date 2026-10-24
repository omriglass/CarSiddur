import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useMyDepartments } from "@/features/auth/useMyDepartments";
import { useProfile } from "@/features/auth/useProfile";

import { fetchCarChecklistStatuses, fetchCarsOverviewData } from "./api";
import { carsOverviewKeys } from "./keys";
import { buildCarOverviewRows, type ChecklistStatus } from "./rows";

/**
 * Who sees the dashboard (and its entry point): an admin, or a car administrator of the active department
 * (`department_members.is_car_admin`). Interface convenience only; the reads are RLS-guarded.
 */
export function useCanViewCarsOverview(): { allowed: boolean; isLoading: boolean; departmentId: string | undefined } {
  const profile = useProfile();
  const memberships = useMyDepartments();
  const active = useActiveDepartment();
  const departmentId = active.departmentId;
  const isCarAdmin = (memberships.data ?? []).some((m) => m.department_id === departmentId && m.is_car_admin);
  return {
    allowed: !!profile.data?.is_admin || isCarAdmin,
    isLoading: profile.isLoading || memberships.isLoading || active.isLoading,
    departmentId,
  };
}

/**
 * Last handover-checklist status per car (REQ item 150 d, `car_checklist_status`). A separate, non-blocking read: if it
 * fails (or the view is not deployed yet) the column shows "no data" and the rest of the dashboard still loads.
 */
export function useCarChecklistStatus(departmentId: string | undefined): { data: Record<string, ChecklistStatus> | undefined } {
  const query = useQuery({
    queryKey: carsOverviewKeys.checklists(departmentId),
    queryFn: () => fetchCarChecklistStatuses(departmentId as string),
    enabled: !!departmentId,
    retry: false,
  });
  return { data: query.data };
}

export function useCarsOverviewQuery(departmentId: string | undefined) {
  const query = useQuery({
    queryKey: carsOverviewKeys.department(departmentId),
    queryFn: () => fetchCarsOverviewData(departmentId as string),
    enabled: !!departmentId,
  });
  const checklists = useCarChecklistStatus(departmentId).data;
  const rows = useMemo(
    () => (query.data ? buildCarOverviewRows({ ...query.data, checklists }) : undefined),
    [query.data, checklists],
  );
  return { ...query, rows };
}
