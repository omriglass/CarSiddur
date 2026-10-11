import { useState } from "react";
import { Link } from "react-router-dom";

import { paths } from "@/app/routes";
import { PageHeader } from "@/components/PageHeader";
import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useProfile } from "@/features/auth/useProfile";
import { useCars } from "@/features/fleet/hooks";
import { useMyRequests } from "@/features/requests/hooks";
import { MyWeekView } from "@/features/requests/myWeek/MyWeekView";
import type { MyWeekTarget } from "@/features/requests/myWeek/myWeekItems";
import { RideDetailSheet } from "@/features/siddur/components/RideDetailSheet";
import type { BoardRide } from "@/features/siddur/api";
import { useBoardRides, useWeeks } from "@/features/siddur/hooks";
import { he } from "@/i18n/he";

/**
 * `/my/archive` — past weeks in the "my rides" week grid, read-only (owner 2026-10-11, UX_FLOWS.md §3.3a). A separate
 * page like the siddur's archive: rarely used, so it stays off `/my`. Rides only; a tap opens the ride sheet with no
 * editing actions.
 */
export function MyArchivePage() {
  const active = useActiveDepartment();
  const profileQuery = useProfile();
  const requestsQuery = useMyRequests();
  const weeksQuery = useWeeks(active.departmentId);
  const carsQuery = useCars(active.departmentId);
  const [selected, setSelected] = useState<BoardRide | null>(null);
  const weekRidesQuery = useBoardRides(active.departmentId, selected?.week_start ?? undefined);
  const homeDestinationId = active.departments.find((d) => d.id === active.departmentId)?.home_destination_id;

  function onTarget(target: MyWeekTarget) {
    if (target.type === "ride") setSelected(target.ride);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 pb-24 lg:max-w-none">
      <PageHeader
        title={he.myWeek.archiveTitle}
        actions={<Link to={paths.my()} className="text-sm font-medium text-primary underline">{he.common.back}</Link>}
      />
      <MyWeekView
        archive
        departmentId={active.departmentId}
        homeDestinationId={homeDestinationId}
        profileId={profileQuery.data?.id}
        requests={requestsQuery.data ?? []}
        weeks={weeksQuery.data ?? []}
        homeWeekStart={undefined}
        canSubmit={false}
        onTarget={onTarget}
      />
      <RideDetailSheet
        ride={selected}
        weekRides={weekRidesQuery.data}
        car={selected ? (carsQuery.data ?? []).find((car) => car.id === selected.car_id) ?? null : null}
        locationBadge={null}
        onOpenChange={(open) => !open && setSelected(null)}
      />
    </div>
  );
}
