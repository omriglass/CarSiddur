import { CarFront } from "lucide-react";

import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { he } from "@/i18n/he";
import { formatTime } from "@/lib/time";

import {
  useApproveClaimMutation,
  useCloseOfferMutation,
  useFreedOffersForWeek,
} from "../../hooks";
import { OfferClaims } from "./OfferClaims";

interface ClaimsScreenProps {
  departmentId: string;
  weekStart: string;
}

/** `/sadran/:dept/:week/claims` — contested freed-slot approval (UX_FLOWS.md §4.4). */
export function ClaimsScreen({ departmentId, weekStart }: ClaimsScreenProps) {
  const offersQuery = useFreedOffersForWeek(departmentId, weekStart);
  const approveMutation = useApproveClaimMutation();
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
                <span className="font-medium" dir="ltr">
                  {formatTime(new Date(offer.starts_at))}–{formatTime(new Date(offer.ends_at))}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => closeMutation.mutate({ offerId: offer.id, departmentId, weekStart })}
                >
                  {he.action.leaveFree}
                </Button>
              </div>
              <OfferClaims
                offerId={offer.id}
                onApprove={(requestId) =>
                  approveMutation.mutate({ offerId: offer.id, requestId, departmentId, weekStart })
                }
              />
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
