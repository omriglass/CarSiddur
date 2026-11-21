// CM1 phase 3 (REQ item 260 c, owner 2026-11-21): two trips chained into one ride, and the long trip has people who are
// not on the short one. They ride the whole ride, or the ride passes the start place again for them - each answer shows
// the route it makes and their time ("לכל הנסיעה" first). Shared by the Sadran's merge popup and the member's merge.
import { Button } from "@/components/ui/button";
import { he, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";

import { chainFirst, chainRouteText, oneTripNames, type ChainOneTrip, type ChainVariant, type MergeChain } from "./mergeChain";

export interface ChainOneTripChoiceProps {
  chain: Pick<MergeChain, "side"> & { oneTrip: ChainOneTrip };
  /** true = pass the start place again (`_via`). */
  via: boolean;
  onChange: (via: boolean) => void;
}

export function ChainOneTripChoice({ chain, via, onChange }: ChainOneTripChoiceProps) {
  const { oneTrip } = chain;
  const first = chainFirst(chain);
  const names = oneTripNames(oneTrip);
  const ask = tv(first ? "mergedRide.chainAskBefore" : "mergedRide.chainAskAfter", { names });
  const option = (isVia: boolean, variant: ChainVariant) => {
    const route = chainRouteText(variant);
    const label = first
      ? (isVia ? tv("mergedRide.chainPickUp", { place: oneTrip.place, route }) : tv("mergedRide.chainWhole", { route }))
      : (isVia ? tv("mergedRide.chainDropOff", { place: oneTrip.place, route }) : tv("mergedRide.chainRideOn", { route }));
    const time = variant.at && oneTrip.was && formatTime(new Date(variant.at)) !== formatTime(new Date(oneTrip.was))
      ? tv(first ? "mergedRide.chainTimeBefore" : "mergedRide.chainTimeAfter",
        { time: formatTime(new Date(variant.at)), was: formatTime(new Date(oneTrip.was)), place: oneTrip.place })
      : null;
    return (
      <Button
        key={String(isVia)}
        type="button"
        role="radio"
        aria-checked={via === isVia}
        disabled={!variant.ok && via !== isVia}
        variant={via === isVia ? "default" : "outline"}
        className="h-auto min-h-11 w-full flex-col items-start whitespace-normal py-2 text-start"
        data-testid={isVia ? "chain-one-trip-via" : "chain-one-trip-plain"}
        onClick={() => onChange(isVia)}
      >
        <span>{label}</span>
        {time ? <span className="text-xs font-normal opacity-80" data-testid="chain-one-trip-time">{time}</span> : null}
        {!variant.ok ? <span className="text-xs font-normal opacity-80">{he.mergedRide.chainTooLong}</span> : null}
      </Button>
    );
  };
  return (
    <div className="space-y-2" data-testid="chain-one-trip">
      <p className="text-xs text-muted-foreground">{ask}</p>
      <div role="radiogroup" aria-label={ask} className="space-y-2">
        {option(false, oneTrip.plain)}
        {option(true, oneTrip.via)}
      </div>
    </div>
  );
}
