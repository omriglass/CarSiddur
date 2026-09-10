import { useNavigate } from "react-router-dom";

import { paths } from "@/app/routes";
import { formatWeekRangeLabel } from "@/components/DateField";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { he, tv } from "@/i18n/he";

import { useBoardWeekSwitcher } from "../useBoardWeekSwitcher";

/** `lg+` department/week Selects, inline in the header (mobile uses `BoardTitleSwitcher` instead). */
export function BoardWeekSwitcher({ departmentId, weekStart }: { departmentId: string; weekStart: string }) {
  const navigate = useNavigate();
  const {
    departmentsQuery, canSwitchDepartments, weeksQuery, availableWeeksQuery, switching, changeDepartment,
  } = useBoardWeekSwitcher(departmentId, weekStart);

  return <div className="flex flex-wrap items-center gap-2">
    {canSwitchDepartments ? <Select value={departmentId} onValueChange={(value) => void changeDepartment(value)} disabled={switching || departmentsQuery.isLoading}>
      <SelectTrigger className="w-36" aria-label={he.siddur.departmentSwitcher}><SelectValue /></SelectTrigger>
      <SelectContent>{(departmentsQuery.data ?? []).map((membership) => <SelectItem key={membership.department_id} value={membership.department_id}>{membership.department.name}</SelectItem>)}</SelectContent>
    </Select> : null}
    <Select value={weekStart} onValueChange={(value) => navigate(paths.sadran.board(departmentId, value))} disabled={switching || weeksQuery.isLoading || availableWeeksQuery.isLoading}>
      <SelectTrigger className="w-56" aria-label={tv("sadranCommon.weekLabel", { label: formatWeekRangeLabel(weekStart) })}><SelectValue>{formatWeekRangeLabel(weekStart)}</SelectValue></SelectTrigger>
      <SelectContent>{(availableWeeksQuery.data ?? []).map((week) => <SelectItem key={week.week_start} value={week.week_start}>{formatWeekRangeLabel(week.week_start)} · {he.phase[week.phase]}</SelectItem>)}</SelectContent>
    </Select>
  </div>;
}
