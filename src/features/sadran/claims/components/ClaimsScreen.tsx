import { CarFront } from "lucide-react";

import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { he } from "@/i18n/he";
import { formatTime } from "@/lib/time";

import { formatDayDate } from "@/lib/dayLabels";

import { useCloseOfferMutation, useFreedOffersForWeek } from "../../hooks";
import { FreedOfferOptions } from "./FreedOfferOptions";

interface ClaimsScreenProps {
  departmentId: string;
  weekStart: string;
}

/** `/sadran/:dept/:week/claims` — freed cars waiting for the Sadran's decision (UX_FLOWS.md §4.4, REQ §13.168). */
export function ClaimsScreen({ departmentId, weekStart }: ClaimsScreenProps) {
  const offersQuery = useFreedOffersForWeek(departmentId, weekStart);
  const closeMutation = useCloseOfferMutation();

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
                <span className="font-medium">
                  {formatDayDate(offer.starts_at)}{" "}
                  <span dir="ltr">{formatTime(new Date(offer.starts_at))}–{formatTime(new Date(offer.ends_at))}</span>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => closeMutation.mutate({ offerId: offer.id, departmentId, weekStart })}
                >
                  {he.action.leaveFree}
                </Button>
              </div>
              <FreedOfferOptions offerId={offer.id} options={offer.options} departmentId={departmentId} weekStart={weekStart} />
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
