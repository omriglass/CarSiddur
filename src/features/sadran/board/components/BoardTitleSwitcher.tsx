import { ChevronDown } from "lucide-react";

import { formatWeekRangeLabel } from "@/components/DateField";
import { StatusBadge } from "@/components/StatusBadge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { he } from "@/i18n/he";

import { useBoardWeekSwitcher } from "../useBoardWeekSwitcher";

/**
 * Mobile board header title (UX_FLOWS.md §4.2, owner spec 2026-09-10): the
 * title *is* the department/week switcher, same idea as the member siddur's
 * `WeekSwitcherTitle` but listing every manageable, non-archived week (the
 * board has no fixed "this/next week" pair) plus a department section when
 * the Sadran manages more than one. Shares `useBoardWeekSwitcher` with the
 * `lg+` inline `BoardWeekSwitcher` so there is exactly one implementation of
 * "which weeks can this Sadran switch to".
 */
export function BoardTitleSwitcher({ departmentId, weekStart, departmentName }: {
  departmentId: string;
  weekStart: string;
  departmentName?: string;
}) {
  const {
    departmentsQuery, canSwitchDepartments, availableWeeksQuery, switching, goToWeek, changeDepartment,
  } = useBoardWeekSwitcher(departmentId, weekStart);

  const weeks = (availableWeeksQuery.data ?? []).filter((week) => week.phase !== "archived");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex min-h-11 items-center gap-1 text-start"
          data-testid="board-title-switcher"
          disabled={switching}
        >
          <span className="flex flex-col items-start">
            <span className="text-lg font-semibold text-foreground">{he.screen.board.title}</span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <span dir="ltr">{formatWeekRangeLabel(weekStart)}</span>
              {departmentName ? <span>· {departmentName}</span> : null}
            </span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>{he.screen.board.title}</DropdownMenuLabel>
        {weeks.map((week) => (
          <DropdownMenuItem
            key={week.week_start}
            data-testid={`board-week-option-${week.week_start}`}
            onSelect={() => goToWeek(week.week_start)}
          >
            <span className="flex w-full items-center justify-between gap-2">
              <span dir="ltr">{formatWeekRangeLabel(week.week_start)}</span>
              <StatusBadge kind="week" status={week.phase} className="h-5 px-1.5 py-0 text-[10px]" />
            </span>
          </DropdownMenuItem>
        ))}
        {canSwitchDepartments ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{he.siddur.departmentSwitcher}</DropdownMenuLabel>
            {(departmentsQuery.data ?? []).map((membership) => (
              <DropdownMenuItem
                key={membership.department_id}
                data-testid={`board-department-option-${membership.department_id}`}
                disabled={membership.department_id === departmentId}
                onSelect={() => void changeDepartment(membership.department_id)}
              >
                {membership.department.name}
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
