import { useLocation } from "react-router-dom";
import { useEffect, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchDepartments } from "@/features/siddur/api";
import { contextKeys } from "./queryKeys";
import { useMyDepartments } from "./useMyDepartments";
import { useProfile } from "./useProfile";
import { useSession } from "./useSession";

const listeners = new Set<() => void>();
const selections = new Map<string, string>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => { listeners.delete(listener); window.removeEventListener("storage", listener); };
}

/** One device-local context per account; department IDs remain part of every data cache key. */
export function useActiveDepartment() {
  const { session } = useSession();
  const { pathname } = useLocation();
  const routeDepartmentId = /^\/(?:siddur|sadran)\/([0-9a-f-]{36})(?:\/|$)/i.exec(pathname)?.[1];
  const profile = useProfile();
  const memberships = useMyDepartments();
  const all = useQuery({ queryKey: contextKeys.departments(session?.user.id), queryFn: fetchDepartments, enabled: !!session });
  const key = `carshare:department:${session?.user.id ?? ""}`;
  const selected = useSyncExternalStore(subscribe, () => {
    try { return localStorage.getItem(key) ?? selections.get(key) ?? ""; } catch { return selections.get(key) ?? ""; }
  }, () => "");
  const departments = (all.data ?? []).filter((department) => department.is_active);
  const candidates = [routeDepartmentId, selected, profile.data?.default_department_id, memberships.data?.[0]?.department_id, departments[0]?.id];
  const departmentId = candidates.find((id): id is string => !!id && departments.some((department) => department.id === id));
  const canSubmit = !!departmentId && !!memberships.data?.some((membership) => membership.department_id === departmentId);
  function setDepartmentId(id: string) {
    if (!departments.some((department) => department.id === id)) return;
    selections.set(key, id);
    try { localStorage.setItem(key, id); } catch { /* Private browser storage can be unavailable. */ }
    listeners.forEach((listener) => listener());
  }
  useEffect(() => {
    if (routeDepartmentId && departments.some((department) => department.id === routeDepartmentId) && selected !== routeDepartmentId) setDepartmentId(routeDepartmentId);
  });
  return { departmentId, departments, setDepartmentId, canSubmit, isLoading: all.isLoading || memberships.isLoading || profile.isLoading };
}
