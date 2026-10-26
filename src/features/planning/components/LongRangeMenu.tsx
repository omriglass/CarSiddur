import { BarChart3, CalendarRange, Scale, Telescope } from "lucide-react";
import { Link } from "react-router-dom";

import { paths } from "@/app/routes";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCanViewDepartmentStats } from "@/features/stats/hooks";
import { he } from "@/i18n/he";

/**
 * REQ §13.154 (owner 2026-10-26): the "big picture" menu beside the eye menu on the siddur and /my — everything about
 * more than next week. Planning first; then, after a line, the policy and the statistics (the latter only for whoever
 * may open it).
 */
export function LongRangeMenu({ departmentId }: { departmentId: string }) {
  const stats = useCanViewDepartmentStats(departmentId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="icon" aria-label={he.planning.longRangeMenu} data-testid="long-range-menu-trigger">
          <Telescope className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem asChild>
          <Link to={paths.plan(departmentId)} data-testid="long-range-planning">
            <CalendarRange className="me-2 size-4" aria-hidden="true" />{he.planning.menuLink}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to={paths.policy(departmentId)} data-testid="long-range-policy">
            <Scale className="me-2 size-4" aria-hidden="true" />{he.policyView.menuLink}
          </Link>
        </DropdownMenuItem>
        {stats.allowed ? (
          <DropdownMenuItem asChild>
            <Link to={paths.stats(departmentId)} data-testid="long-range-stats">
              <BarChart3 className="me-2 size-4" aria-hidden="true" />{he.stats.navMenuItem}
            </Link>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
