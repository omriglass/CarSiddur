import { useNavigate } from "react-router-dom";
import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useMyDepartments } from "@/features/auth/useMyDepartments";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { he } from "@/i18n/he";

export function DepartmentContextSelector() {
  const context = useActiveDepartment();
  const memberships = useMyDepartments();
  const navigate = useNavigate();
  const departments = (memberships.data ?? []).map((membership) => membership.department);
  // This is a switcher, not a department label. Do not spend permanent page
  // space on it unless the member has another department they can select.
  if (departments.length < 2) return null;
  return <div className="flex items-center gap-3 border-b px-4 py-2">
    <label htmlFor="active-department" className="text-sm">{he.departmentContext.label}</label>
    <Select value={context.departmentId ?? ""} onValueChange={(id) => { context.setDepartmentId(id); navigate("/my"); }}>
      <SelectTrigger id="active-department" className="min-h-11 w-48"><SelectValue /></SelectTrigger>
      <SelectContent>{departments.map((department) => <SelectItem key={department.id} value={department.id}>{department.name}</SelectItem>)}</SelectContent>
    </Select>
    {!context.canSubmit && <span className="text-xs text-muted-foreground">{he.departmentContext.viewOnly}</span>}
  </div>;
}
