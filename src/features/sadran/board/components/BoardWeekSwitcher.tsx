import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { formatWeekRangeLabel } from "@/components/DateField";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fetchSadranimOf } from "@/features/auth/api";
import { authKeys } from "@/features/auth/queryKeys";
import { useMyDepartments } from "@/features/auth/useMyDepartments";
import { useSession } from "@/features/auth/useSession";
import { fetchWeeks } from "@/features/siddur/api";
import { useWeeks } from "@/features/siddur/hooks";
import { siddurKeys } from "@/features/siddur/queryKeys";
import { he, tv } from "@/i18n/he";
import { showErrorToast } from "@/lib/rpc";

const PHASE_PRIORITY: Record<string, number> = { open: 0, solving: 1, published: 2, live: 3, archived: 4 };

/** Department/week navigation stays on the board and uses server-resolved assignments. */
export function BoardWeekSwitcher({ departmentId, weekStart }: { departmentId: string; weekStart: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session } = useSession();
  const profileId = session?.user.id;
  const departmentsQuery = useMyDepartments();
  const weeksQuery = useWeeks(departmentId);
  const [switching, setSwitching] = useState(false);

  async function canManage(department: string, week: string) {
    if (!profileId) return false;
    const coordinators = await queryClient.fetchQuery({
      queryKey: authKeys.isSadran(profileId, department, week),
      queryFn: () => fetchSadranimOf(department, week), staleTime: 60_000,
    });
    return coordinators.includes(profileId);
  }

  const availableWeeksQuery = useQuery({
    queryKey: ["sadran", departmentId, "switchableWeeks", profileId, (weeksQuery.data ?? []).map((week) => week.week_start)],
    queryFn: async () => {
      const weeks = weeksQuery.data ?? [];
      const allowed = await Promise.all(weeks.map((week) => canManage(departmentId, week.week_start)));
      return weeks.filter((_, index) => allowed[index]);
    },
    enabled: !!profileId && weeksQuery.isSuccess,
    staleTime: 60_000,
  });

  async function changeDepartment(nextDepartment: string) {
    if (nextDepartment === departmentId) return;
    setSwitching(true);
    try {
      const weeks = await queryClient.fetchQuery({
        queryKey: siddurKeys.weeks(nextDepartment), queryFn: () => fetchWeeks(nextDepartment), staleTime: 60_000,
      });
      const candidates = [...weeks].sort((a, b) =>
        Number(b.week_start === weekStart) - Number(a.week_start === weekStart)
        || (PHASE_PRIORITY[a.phase] ?? 99) - (PHASE_PRIORITY[b.phase] ?? 99)
        || a.week_start.localeCompare(b.week_start));
      for (const week of candidates) {
        if (await canManage(nextDepartment, week.week_start)) {
          navigate(`/sadran/${nextDepartment}/${week.week_start}/board`);
          return;
        }
      }
      toast.error(he.sadranCommon.notSadranOfThis);
    } catch (error) {
      showErrorToast(error);
    } finally {
      setSwitching(false);
    }
  }

  return <div className="flex flex-wrap items-center gap-2">
    <Select value={departmentId} onValueChange={(value) => void changeDepartment(value)} disabled={switching || departmentsQuery.isLoading}>
      <SelectTrigger className="w-36" aria-label={he.siddur.departmentSwitcher}><SelectValue /></SelectTrigger>
      <SelectContent>{(departmentsQuery.data ?? []).map((membership) => <SelectItem key={membership.department_id} value={membership.department_id}>{membership.department.name}</SelectItem>)}</SelectContent>
    </Select>
    <Select value={weekStart} onValueChange={(value) => navigate(`/sadran/${departmentId}/${value}/board`)} disabled={switching || weeksQuery.isLoading || availableWeeksQuery.isLoading}>
      <SelectTrigger className="w-56" aria-label={tv("sadranCommon.weekLabel", { label: formatWeekRangeLabel(weekStart) })}><SelectValue>{formatWeekRangeLabel(weekStart)}</SelectValue></SelectTrigger>
      <SelectContent>{(availableWeeksQuery.data ?? []).map((week) => <SelectItem key={week.week_start} value={week.week_start}>{formatWeekRangeLabel(week.week_start)} · {he.phase[week.phase]}</SelectItem>)}</SelectContent>
    </Select>
  </div>;
}
