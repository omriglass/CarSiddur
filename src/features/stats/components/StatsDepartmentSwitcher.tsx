import { useNavigate } from "react-router-dom";

import { paths } from "@/app/routes";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { he } from "@/i18n/he";

import type { StatsDepartmentOption } from "../hooks";

interface StatsDepartmentSwitcherProps {
  departmentId: string;
  options: StatsDepartmentOption[];
}

/** Department switcher for a user who manages more than one (UX_FLOWS.md §5.12); navigates to `paths.stats(id)`. */
export function StatsDepartmentSwitcher({ departmentId, options }: StatsDepartmentSwitcherProps) {
  const navigate = useNavigate();

  return (
    <Select value={departmentId} onValueChange={(id) => navigate(paths.stats(id))}>
      <SelectTrigger className="min-h-11 w-44" aria-label={he.departmentContext.label} data-testid="stats-department-switcher">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
