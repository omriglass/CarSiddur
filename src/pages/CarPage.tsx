import { CarFront, Lock } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { CardListSkeleton } from "@/components/skeletons/CardListSkeleton";
import { Button } from "@/components/ui/button";
import { useProfile } from "@/features/auth/useProfile";
import { CarManageScreen } from "@/features/cars/components/CarManageScreen";
import { useCarQuery } from "@/features/cars/hooks";
import { he } from "@/i18n/he";

/**
 * `/cars/:carId` — car page (car care portal, REQUIREMENTS §6.6,
 * UX_FLOWS.md §5.11). Guard: admins and the car's `responsible_id` see the
 * full manage screen (details/history/export); everyone else — including
 * an approved member with no relation to this car — sees the shared
 * not-authorized empty state, same pattern as every other role-gated
 * screen in this app (`he.errors.notAuthorized`).
 */
export function CarPage() {
  const { carId } = useParams<{ carId: string }>();
  const profileQuery = useProfile();
  const carQuery = useCarQuery(carId);

  if (profileQuery.isLoading || carQuery.isLoading) {
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
  const isResponsible = !!profile && car.responsible_id === profile.id;

  if (!isAdmin && !isResponsible) {
    return (
      <div className="mx-auto max-w-2xl p-4">
        <EmptyState
          icon={Lock}
          message={he.errors.notAuthorized}
          action={<Button asChild size="sm"><Link to="/my">{he.carPage.backHome}</Link></Button>}
        />
      </div>
    );
  }

  return (
    <CarManageScreen
      car={car}
      isAdmin={isAdmin}
      viewerName={profile?.full_name ?? ""}
    />
  );
}
