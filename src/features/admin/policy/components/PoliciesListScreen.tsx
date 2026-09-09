import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { Plus, ScrollText } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { EmptyState } from "@/components/EmptyState";
import { FormDialog } from "@/components/FormDialog";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useOperationalDepartments } from "@/features/admin/useOperations";
import { he } from "@/i18n/he";
import { showErrorToast } from "@/lib/rpc";

import { useCreatePolicyMutation, usePoliciesAdmin } from "../hooks";

export function PoliciesListScreen() {
  const policiesQuery = usePoliciesAdmin();
  const departmentsQuery = useOperationalDepartments();
  const createMutation = useCreatePolicyMutation();
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const { departmentId } = useActiveDepartment();

  const departmentsById = new Map((departmentsQuery.data ?? []).map((d) => [d.id, d.name]));
  const policies = (policiesQuery.data ?? []).filter((policy) => departmentsById.has(policy.department_id));

  async function submit() {
    if (!name.trim() || !departmentId) return;
    try {
      const created = await createMutation.mutateAsync({ name: name.trim(), department_id: departmentId });
      setOpen(false);
      setName("");
      navigate(`/admin/policies/${created.id}`);
    } catch (error) {
      showErrorToast(error);
    }
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4">
      <PageHeader
        title={he.screen.admin.policies}
        subtitle={he.adminPolicy.subtitle}
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus className="me-1 size-4" /> {he.adminPolicy.new}
          </Button>
        }
      />

      {policies.length === 0 ? (
        <EmptyState icon={ScrollText} message={he.adminPolicy.empty} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{he.adminCommon.name}</TableHead>
              <TableHead>{he.adminPolicy.department}</TableHead>
              <TableHead>{he.adminCommon.active}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {policies.map((p) => (
              <TableRow key={p.id} className="cursor-pointer" onClick={() => navigate(`/admin/policies/${p.id}`)}>
                <TableCell>{p.name}</TableCell>
                <TableCell>{departmentsById.get(p.department_id) ?? p.department_id}</TableCell>
                <TableCell>
                  <Badge variant={p.is_active ? "default" : "outline"}>
                    {p.is_active ? he.adminCommon.active : he.adminCommon.inactive}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <FormDialog open={open} onOpenChange={setOpen} title={he.adminPolicy.new} onSubmit={submit}>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            {he.adminCommon.name}
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {he.adminPolicy.department}
            <Select value={departmentId} disabled>
              <SelectTrigger>
                <SelectValue placeholder={he.departmentContext.label} />
              </SelectTrigger>
              <SelectContent>
                {(departmentsQuery.data ?? []).map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>
      </FormDialog>
    </div>
  );
}
