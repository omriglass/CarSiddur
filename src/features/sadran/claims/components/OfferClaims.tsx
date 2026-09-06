import { Button } from "@/components/ui/button";
import { he, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";

import { useClaimsForOffer, useProfilesByIds } from "../../hooks";

interface OfferClaimsProps {
  offerId: string;
  onApprove: (requestId: string) => void;
}

/** One offer's candidate list (`ClaimList`, UX_FLOWS.md §4.4): candidate, when they claimed, approve. */
export function OfferClaims({ offerId, onApprove }: OfferClaimsProps) {
  const claimsQuery = useClaimsForOffer(offerId);
  const claims = (claimsQuery.data ?? []).filter((c) => c.status === "offered" || c.status === "claimed");
  const profilesQuery = useProfilesByIds(claims.map((c) => c.profile_id));

  return (
    <ul className="space-y-1">
      {claims.map((c) => {
        const profile = profilesQuery.data?.find((p) => p.id === c.profile_id);
        return (
          <li key={c.id} className="flex items-center justify-between gap-2 rounded-md border p-2 text-xs">
            <div>
              <div className="font-medium">{profile?.full_name ?? c.profile_id}</div>
              {c.claimed_at ? (
                <div className="text-muted-foreground">
                  {tv("sadranClaims.claimedAt", { time: formatTime(new Date(c.claimed_at)) })}
                </div>
              ) : null}
            </div>
            <Button size="sm" onClick={() => onApprove(c.request_id)}>
              {he.action.approveClaim}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
