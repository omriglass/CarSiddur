import { useNavigate } from "react-router-dom";
import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { he } from "@/i18n/he";

export function DepartmentContextSelector() {
  const context = useActiveDepartment();
  const navigate = useNavigate();
  // All active departments, not just ones the member belongs to (REQ §13.52): a member can
  // browse another department's published siddur read-only; `context.canSubmit` below reflects
  // actual membership for the currently selected one.
  const departments = context.departments;
  // This is a switcher, not a department label. Do not spend permanent page
  // space on it unless there is another department at all to switch to.
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
