import { CarFront, MapPin } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";

import { paths } from "@/app/routes";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { CardListSkeleton } from "@/components/skeletons/CardListSkeleton";
import { Button } from "@/components/ui/button";
import { useProfile } from "@/features/auth/useProfile";
import { useCars } from "@/features/fleet/hooks";
import { useClaimRideDriverMutation } from "@/features/rides/hooks";
import { driverWantedRiders, isDrivenOnRide } from "@/features/rides/driverWanted";
import { relayPartnerOf, servedOf } from "@/features/rides/servedOf";
import { useBoardRideById, useDepartments } from "@/features/siddur/hooks";
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { rideBlockLabel } from "@/lib/rideLabel";
import { siddurCarName } from "@/lib/siddurCarName";
import { formatTime } from "@/lib/time";

/**
 * `/ride/:rideId` (REQ §13.170): the page the "who can drive?" WhatsApp message links to — just the ride's details
 * and "אני אקח" (`claim_ride_driver`, the same as the ride sheet's "אני אנהג בנסיעה הזו").
 */
export function RideOfferPage() {
  const { rideId } = useParams<{ rideId: string }>();
  const rideQuery = useBoardRideById(rideId);
  const profileQuery = useProfile();
  const departmentsQuery = useDepartments();
  const ride = rideQuery.data ?? null;
  const carsQuery = useCars(ride?.department_id ?? undefined);
  const claim = useClaimRideDriverMutation();
  const [openedAt] = useState(() => Date.now());

  if (rideQuery.isLoading || profileQuery.isLoading) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-4">
        <PageHeader title={he.driverWanted.pageTitle} />
        <CardListSkeleton count={2} />
      </div>
    );
  }
  if (!ride?.id || !ride.starts_at) {
    return (
      <div className="mx-auto max-w-2xl p-4">
        <EmptyState icon={CarFront} message={he.driverWanted.notFound}
          action={<Button asChild size="sm"><Link to={paths.siddur()}>{he.driverWanted.toSiddur}</Link></Button>} />
      </div>
    );
  }

  const served = servedOf(ride);
  const homeDestinationId = (departmentsQuery.data ?? []).find((d) => d.id === ride.department_id)?.home_destination_id ?? null;
  const label = homeDestinationId && ride.origin_id && ride.destination_id
    ? rideBlockLabel({
      originId: ride.origin_id, destinationId: ride.destination_id, originName: ride.origin_name ?? "", destinationName: ride.destination_name ?? "",
      homeDestinationId, served, driverName: ride.driver_name, isChauffeur: !!ride.is_chauffeur, needsDriver: !!ride.needs_driver,
      autoRelocation: !!ride.auto_relocation, carMove: ride.pin_reason === "CAR_MOVE", startsAt: ride.starts_at, relayPartner: relayPartnerOf(ride),
    })
    : (ride.destination_name ?? "");
  const riders = driverWantedRiders(ride).map((person) => person.name);
  const car = (carsQuery.data ?? []).find((c) => c.id === ride.car_id);
  const past = !!ride.ends_at && Date.parse(ride.ends_at) <= openedAt;
  const cancelled = ride.status === "cancelled";
  const doesNotDrive = !!profileQuery.data?.does_not_drive;
  const drivenOnIt = isDrivenOnRide(ride, profileQuery.data?.id);
  const open = !!ride.needs_driver && !cancelled && !past;

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 text-sm">
      <PageHeader title={open ? he.driverWanted.pageTitle : he.rideDetail.title} />
      <div className="space-y-3 rounded-lg border p-4" data-testid="ride-offer">
        <p className="font-medium">
          {formatDayDate(ride.starts_at)}{" · "}
          <span dir="ltr" className="tabular-nums">{formatTime(new Date(ride.starts_at))}{ride.ends_at ? `–${formatTime(new Date(ride.ends_at))}` : ""}</span>
        </p>
        <p className="flex items-center gap-1"><MapPin className="size-4 shrink-0 text-muted-foreground" />{label}</p>
        {riders.length ? <p>{tv("driverWanted.riders", { names: riders.join(", ") })}</p> : null}
        {car ? <p className="flex items-center gap-1"><CarFront className="size-4 shrink-0 text-muted-foreground" />{siddurCarName(car)}</p> : null}
        {ride.notes ? <p className="whitespace-pre-wrap break-words text-muted-foreground">{ride.notes}</p> : null}
      </div>

      {cancelled ? <p className="font-medium text-muted-foreground">{he.driverWanted.cancelled}</p>
        : past ? <p className="font-medium text-muted-foreground">{he.driverWanted.past}</p>
          : !ride.needs_driver ? (
            <p className="font-medium" data-testid="ride-offer-has-driver">
              {ride.driver_id && ride.driver_id === profileQuery.data?.id ? he.driverWanted.taken : tv("driverWanted.hasDriver", { name: ride.driver_name ?? "" })}
            </p>
          ) : drivenOnIt ? <p className="text-muted-foreground">{he.rideCoordination.ownDropoffDriver}</p>
            : doesNotDrive ? <p className="text-muted-foreground">{he.driverWanted.doesNotDrive}</p> : null}

      {open && !doesNotDrive && !drivenOnIt ? (
        <Button className="w-full" size="lg" disabled={claim.isPending} data-testid="ride-offer-take"
          onClick={() => {
            if (ride.version != null) claim.mutate({ rideId: ride.id!, expectedVersion: ride.version }, {
              onSuccess: () => { toast.success(he.driverWanted.taken); void rideQuery.refetch(); },
            });
          }}>
          {he.driverWanted.take}
        </Button>
      ) : null}

      <Button asChild variant="outline" className="w-full">
        <Link to={paths.siddur({ dept: ride.department_id ?? undefined, week: ride.week_start ?? undefined, rideId: ride.id })}>{he.driverWanted.toSiddur}</Link>
      </Button>
    </div>
  );
}
