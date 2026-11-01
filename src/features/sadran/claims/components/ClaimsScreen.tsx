import { CarFront } from "lucide-react";

import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { he, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";

import { formatDayDate } from "@/lib/dayLabels";

import { useCloseOfferMutation, useFreedOffersForWeek, useRefreshFreedOfferMutation } from "../../hooks";
import { FreedOfferOptions } from "./FreedOfferOptions";

interface ClaimsScreenProps {
  departmentId: string;
  weekStart: string;
}

/** `/sadran/:dept/:week/claims` — freed cars waiting for the Sadran's decision (UX_FLOWS.md §4.4, REQ §13.168). */
export function ClaimsScreen({ departmentId, weekStart }: ClaimsScreenProps) {
  const offersQuery = useFreedOffersForWeek(departmentId, weekStart);
  const closeMutation = useCloseOfferMutation();
  const refreshMutation = useRefreshFreedOfferMutation();

  const contested = (offersQuery.data ?? []).filter((o) => o.status === "pending_approval");

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-4 pb-24">
      <PageHeader title={he.screen.claims.title} />

      {contested.length === 0 ? (
        <EmptyState icon={CarFront} message={he.sadranClaims.empty} />
      ) : (
        contested.map((offer) => (
          <Card key={offer.id}>
            <CardContent className="space-y-2 p-4 text-sm">
              <div className="flex items-center justify-between">
                {/* R17U4: which car, which day, and the cancelled ride's hours (the free gap can be the whole day). */}
                <span className="font-medium">
                  {tv("sadranClaims.offerHeading", { car: offer.car?.name ?? "", day: formatDayDate(offer.starts_at) })}{" · "}
                  <span dir="ltr">
                    {offer.cancelled_ride
                      ? `${formatTime(new Date(offer.cancelled_ride.starts_at))}–${formatTime(new Date(offer.cancelled_ride.ends_at))}`
                      : `${formatTime(new Date(offer.starts_at))}–${formatTime(new Date(offer.ends_at))}`}
                  </span>
                </span>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={refreshMutation.isPending} data-testid="freed-offer-refresh"
                    onClick={() => refreshMutation.mutate({ offerId: offer.id, departmentId, weekStart })}>
                    {he.sadranClaims.refresh}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => closeMutation.mutate({ offerId: offer.id, departmentId, weekStart })}
                  >
                    {he.action.leaveFree}
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {tv("sadranClaims.freeGap", { range: `${formatTime(new Date(offer.starts_at))}–${formatTime(new Date(offer.ends_at))}` })}
              </p>
              <FreedOfferOptions offerId={offer.id} options={offer.options} departmentId={departmentId} weekStart={weekStart} />
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
