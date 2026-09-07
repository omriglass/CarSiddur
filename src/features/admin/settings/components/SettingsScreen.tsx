import { useState } from "react";

import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DepartmentForm } from "@/features/admin/departments/components/DepartmentsScreen";
import type { Department } from "@/features/admin/departments/api";
import { useOperationalDepartments } from "@/features/admin/useOperations";
import { he } from "@/i18n/he";

/** Operational settings are editable without access to department or member administration. */
export function SettingsScreen() {
  const departmentsQuery = useOperationalDepartments();
  const [editing, setEditing] = useState<Department | null>(null);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <PageHeader title={he.screen.admin.settings} subtitle={he.adminSettings.subtitle} />
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">{he.adminSettings.departmentSectionTitle}</h2>
        {(departmentsQuery.data ?? []).map((department) => (
          <div key={department.id} className="flex items-center justify-between rounded-md border p-3">
            <span>{department.name}</span>
            <Button size="sm" variant="outline" onClick={() => setEditing(department)}>{he.adminCommon.edit}</Button>
          </div>
        ))}
      </section>
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogHeader><DialogTitle>{he.screen.admin.settings} · {editing?.name}</DialogTitle></DialogHeader>
          {editing ? <DepartmentForm key={editing.id} department={editing} settingsOnly onSaved={() => setEditing(null)} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
