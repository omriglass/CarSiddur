import { he, tv } from "@/i18n/he";

import { formatPercent } from "../format";
import { StatTile } from "./StatTile";

import type { SharingStat } from "../types";

interface SharingTilesProps {
  sharing: SharingStat;
}

/**
 * S2 -- same-day sharing indicators (owner request 2026-09-14, docs/TODO.md "S -- Statistics
 * group"): three independent numbers, deliberately no combined score. Rendered as three plain
 * `StatTile` blocks inside the main tile grid, one headline number each (owner follow-up
 * 2026-09-14: the earlier single three-column card read as one muddled figure).
 */
export function SharingTiles({ sharing }: SharingTilesProps) {
  return (
    <>
      <StatTile
        testId="stats-sharing-people-utilization"
        label={he.stats.sharing.peopleUtilization}
        value={<span dir="ltr">{formatPercent(sharing.peopleUtilization)}</span>}
        help={he.stats.sharing.peopleUtilizationHelp}
      />
      <StatTile
        testId="stats-sharing-fragmentation"
        label={he.stats.sharing.fragmentation}
        value={<span dir="ltr">{sharing.fragmentation.toFixed(1)}</span>}
        sub={tv("stats.sharing.fragmentationSub", {
          rides: String(sharing.fragmentationRideCount),
          days: String(sharing.activeCarDays),
        })}
        help={he.stats.sharing.fragmentationHelp}
      />
      <StatTile
        testId="stats-sharing-one-way"
        label={he.stats.sharing.oneWayFulfilment}
        value={<span dir="ltr">{formatPercent(sharing.oneWayFulfilment)}</span>}
        sub={tv("stats.sharing.oneWaySub", {
          served: String(sharing.oneWayServed),
          total: String(sharing.oneWayTotal),
        })}
        help={he.stats.sharing.oneWayHelp}
      />
    </>
  );
}
