import { Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { paths } from "@/app/routes";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { TableRowsSkeleton } from "@/components/skeletons/TableRowsSkeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useOperationalDepartments } from "@/features/admin/useOperations";
import { he } from "@/i18n/he";

import { useAllDepartmentMembers, useAllProfiles } from "../../members/hooks";
import { useCarsAdmin } from "../hooks";
import { CarForm } from "./CarForm";
import type { Car } from "../api";

export function CarsScreen({ initialCarId }: { initialCarId?: string } = {}) {
  const carsQuery = useCarsAdmin();
  const departmentsQuery = useOperationalDepartments();
  const profilesQuery = useAllProfiles();
  const deptMembersQuery = useAllDepartmentMembers();
  const [editing, setEditing] = useState<Car | null | undefined>(undefined);
  // Deep-link support for `/admin/cars/:id` (UX_FLOWS §2.1 route table): open
  // that car's editor sheet once its row has loaded, without a fetch effect
  // (state-adjustment-during-render, same pattern as TimeField15's re-sync).
  const [openedInitialFor, setOpenedInitialFor] = useState<string | undefined>(undefined);
  if (initialCarId && initialCarId !== openedInitialFor && carsQuery.data) {
    const match = carsQuery.data.find((c) => c.id === initialCarId && departmentsQuery.data?.some((department) => department.id === c.department_id));
    if (match) {
      setOpenedInitialFor(initialCarId);
      setEditing(match);
    }
  }

  const departmentsById = new Map((departmentsQuery.data ?? []).map((d) => [d.id, d.name]));
  const profilesById = new Map((profilesQuery.data ?? []).map((p) => [p.id, p.full_name]));
  const cars = (carsQuery.data ?? []).filter((car) => departmentsQuery.data?.some((department) => department.id === car.department_id));

  // Department-members combobox candidates for the "אחראי/ת רכב" picker (CarForm.responsibleOptions),
  // scoped to whichever department the form's `department_id` field currently holds.
  function responsibleOptionsFor(departmentId: string | undefined) {
    if (!departmentId) return [];
    return (deptMembersQuery.data ?? [])
      .filter((member) => member.department_id === departmentId)
      .map((member) => ({ id: member.profile_id, name: profilesById.get(member.profile_id) ?? member.profile_id }))
      .filter((option, index, all) => all.findIndex((o) => o.id === option.id) === index);
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <PageHeader
        title={he.screen.admin.cars}
        subtitle={he.adminCars.subtitle}
        actions={
          <Button onClick={() => setEditing(null)}>
            <Plus className="me-1 size-4" /> {he.adminCars.new}
          </Button>
        }
      />

      {carsQuery.isLoading ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{he.adminCars.fieldName}</TableHead>
              <TableHead>{he.adminCars.fieldPlate}</TableHead>
              <TableHead>{he.adminCars.fieldDepartment}</TableHead>
              <TableHead>{he.adminCars.fieldType}</TableHead>
              <TableHead>{he.adminCars.fieldStatus}</TableHead>
              <TableHead>{he.adminCars.columnResponsible}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRowsSkeleton columns={6} />
          </TableBody>
        </Table>
      ) : cars.length === 0 ? (
        <EmptyState icon={Plus} message={he.adminCars.empty} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{he.adminCars.fieldName}</TableHead>
              <TableHead>{he.adminCars.fieldPlate}</TableHead>
              <TableHead>{he.adminCars.fieldDepartment}</TableHead>
              <TableHead>{he.adminCars.fieldType}</TableHead>
              <TableHead>{he.adminCars.fieldStatus}</TableHead>
              <TableHead>{he.adminCars.columnResponsible}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cars.map((car) => (
              <TableRow key={car.id} className="cursor-pointer" onClick={() => setEditing(car)}>
                <TableCell>
                  <Link
                    to={paths.car(car.id)}
                    onClick={(event) => event.stopPropagation()}
                    className="underline-offset-2 hover:underline"
                  >
                    {car.name}
                  </Link>
                  {car.is_replaced ? <Badge variant="outline" className="ms-2">{he.adminCars.replacedBadge}</Badge> : null}
                </TableCell>
                <TableCell dir="ltr">{car.license_plate}</TableCell>
                <TableCell>{departmentsById.get(car.department_id) ?? car.department_id}</TableCell>
                <TableCell>{he.car.type[car.type]}</TableCell>
                <TableCell>
                  <StatusBadge kind="car" status={car.status} />
                </TableCell>
                <TableCell>{car.responsible_id ? profilesById.get(car.responsible_id) ?? car.responsible_id : he.adminCars.noResponsible}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Sheet open={editing !== undefined} onOpenChange={(open) => !open && setEditing(undefined)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{editing ? he.adminCars.edit : he.adminCars.new}</SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            {editing !== undefined ? (
              <CarForm
                car={editing}
                departments={departmentsQuery.data ?? []}
                responsibleOptions={responsibleOptionsFor(editing?.department_id ?? departmentsQuery.data?.[0]?.id)}
                onSaved={() => setEditing(undefined)}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
