import { CarFront } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { CardListSkeleton } from "@/components/skeletons/CardListSkeleton";
import { Button } from "@/components/ui/button";
import { useMyDepartments } from "@/features/auth/useMyDepartments";
import { useProfile } from "@/features/auth/useProfile";
import { CarManageScreen } from "@/features/cars/components/CarManageScreen";
import { useCarQuery } from "@/features/cars/hooks";
import { useCanEditMaintenance } from "@/features/fleet/hooks";
import { he } from "@/i18n/he";

/**
 * `/cars/:carId` — car page (car care portal, REQUIREMENTS §6.6,
 * UX_FLOWS.md §5.11). Every approved member may open it read-only; admins, the permanent Sadranim of
 * the car's department (the `can_manage_operations` rule of the `cars` RLS policies), the car's
 * `responsible_id` and, on shared cars, the department's car administrators can edit (`canEdit`, via `useCanEditMaintenance`).
 */
export function CarPage() {
  const { carId } = useParams<{ carId: string }>();
  const profileQuery = useProfile();
  const carQuery = useCarQuery(carId);
  const myDepartmentsQuery = useMyDepartments();
  // Same rule as the cars RLS write policies: admin ∨ department Sadran ∨ the car's responsible person.
  const canEditCar = useCanEditMaintenance(carQuery.data?.department_id);

  if (profileQuery.isLoading || carQuery.isLoading || myDepartmentsQuery.isLoading) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-4">
        <PageHeader title={he.carPage.tabDetails} />
        <CardListSkeleton count={3} />
      </div>
    );
  }

  if (carQuery.isError) {
    return <ErrorState onRetry={() => void carQuery.refetch()} />;
  }

  if (!carQuery.data) {
    return (
      <div className="mx-auto max-w-2xl p-4">
        <EmptyState
          icon={CarFront}
          message={he.carPage.notFound}
          action={<Button asChild size="sm"><Link to="/my">{he.carPage.backHome}</Link></Button>}
        />
      </div>
    );
  }

  const car = carQuery.data;
  const profile = profileQuery.data;
  const isAdmin = !!profile?.is_admin;
  const isDepartmentSadran = (myDepartmentsQuery.data ?? []).some(
    (membership) => membership.department_id === car.department_id && membership.role === "sadran",
  );
  // REQ item 150 (a): `can_manage_car` — admin, the car's responsible person, or (shared car) a car administrator
  // of its department. The Sadran is not part of it (kilometrage corrections, tasks, checklists).
  const isCarAdminHere = (myDepartmentsQuery.data ?? []).some(
    (membership) => membership.department_id === car.department_id && membership.is_car_admin,
  );
  const canManageCar =
    isAdmin || (!!profile?.id && car.responsible_id === profile.id) || (isCarAdminHere && car.type === "shared");
  // Admins and the department's Sadranim manage every field (owner 2026-10-08: a Sadran could not
  // open or save a car); the responsible person keeps the limited view.
  const canManage = isAdmin || isDepartmentSadran;
  const canEdit = canEditCar(car);
  // REQ item 150 (d): the department's checklist items are defined by admins and car administrators.
  const canDefineChecklist = isAdmin || isCarAdminHere;
  // REQ item 150 (a): a car administrator of a private car may change only the status.
  const canSetStatusOnly = isCarAdminHere && car.type === "temporary" && !isAdmin && car.responsible_id !== profile?.id && car.owner_id !== profile?.id;

  return (
    <CarManageScreen
      car={car}
      isAdmin={canManage}
      canEdit={canEdit}
      canManageCar={canManageCar}
      canDefineChecklist={canDefineChecklist}
      canSetStatusOnly={canSetStatusOnly}
      viewerName={profile?.full_name ?? ""}
    />
  );
}
