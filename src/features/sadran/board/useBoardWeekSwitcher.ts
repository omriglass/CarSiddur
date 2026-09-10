import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { paths } from "@/app/routes";
import { fetchCanManageWeek } from "@/features/auth/api";
import { authKeys } from "@/features/auth/queryKeys";
import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useMyDepartments } from "@/features/auth/useMyDepartments";
import { useSession } from "@/features/auth/useSession";
import { sadranKeys } from "@/features/sadran/keys";
import { fetchWeeks } from "@/features/siddur/api";
import { useWeeks } from "@/features/siddur/hooks";
import { siddurKeys } from "@/features/siddur/queryKeys";
import { he } from "@/i18n/he";
import { showErrorToast } from "@/lib/rpc";

const PHASE_PRIORITY: Record<string, number> = { open: 0, solving: 1, published: 2, live: 3, archived: 4 };

/**
 * Shared department/week-switching data + navigation for the board header,
 * used by both the `lg+` inline selects (`BoardWeekSwitcher`) and the mobile
 * tap-title dropdown (`BoardTitleSwitcher`) — extracted so the two
 * renderings share one implementation (CLAUDE.md Conventions: no duplicated
 * logic between an inline control and its menu equivalent).
 */
export function useBoardWeekSwitcher(departmentId: string, weekStart: string) {
  const navigate = useNavigate();
  const active = useActiveDepartment();
  const queryClient = useQueryClient();
  const { session } = useSession();
  const profileId = session?.user.id;
  const departmentsQuery = useMyDepartments();
  const weeksQuery = useWeeks(departmentId);
  const [switching, setSwitching] = useState(false);

  async function canManage(department: string, week: string) {
    if (!profileId) return false;
    return queryClient.fetchQuery({
      queryKey: authKeys.isSadran(profileId, department, week),
      queryFn: () => fetchCanManageWeek(department, week), staleTime: 60_000,
    });
  }

  const availableWeeksQuery = useQuery({
    queryKey: sadranKeys.switchableWeeks(departmentId, profileId, (weeksQuery.data ?? []).map((week) => week.week_start)),
    queryFn: async () => {
      const weeks = weeksQuery.data ?? [];
      const allowed = await Promise.all(weeks.map((week) => canManage(departmentId, week.week_start)));
      return weeks.filter((_, index) => allowed[index]);
    },
    enabled: !!profileId && weeksQuery.isSuccess,
    staleTime: 60_000,
  });

  function goToWeek(nextWeekStart: string) {
    navigate(paths.sadran.board(departmentId, nextWeekStart));
  }

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
          active.setDepartmentId(nextDepartment);
          navigate(paths.sadran.board(nextDepartment, week.week_start));
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

  return {
    departmentsQuery,
    canSwitchDepartments: (departmentsQuery.data?.length ?? 0) > 1,
    weeksQuery,
    availableWeeksQuery,
    switching,
    goToWeek,
    changeDepartment,
  };
}
