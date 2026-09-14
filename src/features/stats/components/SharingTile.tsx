import { Card, CardContent } from "@/components/ui/card";
import { he, tv } from "@/i18n/he";

import { formatPercent } from "../format";

import type { SharingStat } from "../types";

interface SharingTileProps {
  sharing: SharingStat;
}

/**
 * S2 -- same-day sharing indicators (owner request 2026-09-14, docs/TODO.md "S -- Statistics
 * group"): one tile, three independent numbers, deliberately no combined score. Unlike
 * `StatTile` (one headline value), this tile shows all three side by side since none of them
 * is "the" number -- peopleUtilization/oneWayFulfilment are percentages (formatted like the
 * existing utilization tile), fragmentation is an average rides-per-active-car-day.
 */
export function SharingTile({ sharing }: SharingTileProps) {
  return (
    <Card className="bg-gradient-card shadow-card" data-testid="stats-tile-sharing">
      <CardContent className="space-y-3 p-4">
        <p className="text-xs text-muted-foreground">{he.stats.sharing.title}</p>
        <div className="grid grid-cols-3 gap-2">
          <div data-testid="stats-sharing-people-utilization">
            <p className="text-lg font-semibold text-foreground" dir="ltr">
              {formatPercent(sharing.peopleUtilization)}
            </p>
            <p className="text-[11px] leading-snug text-muted-foreground">{he.stats.sharing.peopleUtilization}</p>
          </div>
          <div data-testid="stats-sharing-fragmentation">
            <p className="text-lg font-semibold text-foreground" dir="ltr">
              {sharing.fragmentation.toFixed(1)}
            </p>
            <p className="text-[11px] leading-snug text-muted-foreground">{he.stats.sharing.fragmentation}</p>
            <p className="text-[10px] text-muted-foreground/70">
              {tv("stats.sharing.fragmentationSub", {
                rides: String(sharing.fragmentationRideCount),
                days: String(sharing.activeCarDays),
              })}
            </p>
          </div>
          <div data-testid="stats-sharing-one-way">
            <p className="text-lg font-semibold text-foreground" dir="ltr">
              {formatPercent(sharing.oneWayFulfilment)}
            </p>
            <p className="text-[11px] leading-snug text-muted-foreground">{he.stats.sharing.oneWayFulfilment}</p>
            <p className="text-[10px] text-muted-foreground/70">
              {tv("stats.sharing.oneWaySub", {
                served: String(sharing.oneWayServed),
                total: String(sharing.oneWayTotal),
              })}
            </p>
          </div>
        </div>
        <p className="text-[11px] leading-snug text-muted-foreground/80">{he.stats.sharing.help}</p>
      </CardContent>
    </Card>
  );
}
