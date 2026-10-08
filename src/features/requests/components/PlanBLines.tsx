// REQ §13.112 (a)/(b): the "אם אין רכב" lines of a `/my` request card — its plan B / "אסתדר" while it waits for a
// car, and "שובצת בתוכנית ב׳ …" + the original request once it is served by its plan B (`fallbackLine.ts`).
import { useDestinations } from "@/features/fleet/hooks";

import { originalRequestLine, servedByAlternativeLine, waitingFallbackLine } from "../fallbackLine";
import { LtrText } from "./requestForm/sentence/LtrText";

import type { MyRequestRow } from "../api";

type PlanBRow = Pick<MyRequestRow, "status" | "departmentId" | "fallback" | "servedByAlternative" | "alternative">;

function ServedLines({ row }: { row: PlanBRow & { alternative: NonNullable<MyRequestRow["alternative"]> } }) {
  const destinations = useDestinations(row.departmentId);
  const names = new Map((destinations.data ?? []).map((d) => [d.id, d.name]));
  const original = originalRequestLine(row.alternative.originalMain, { destinationName: (id) => names.get(id) });
  return (
    <div className="space-y-0.5" data-testid="request-served-by-plan-b">
      <p className="text-xs font-medium"><LtrText text={servedByAlternativeLine(row.alternative)} /></p>
      {original ? <p className="text-xs text-muted-foreground" data-testid="request-original-main"><LtrText text={original} /></p> : null}
    </div>
  );
}

export function PlanBLines({ row }: { row: PlanBRow }) {
  if (row.servedByAlternative && row.alternative) return <ServedLines row={{ ...row, alternative: row.alternative }} />;
  const line = waitingFallbackLine(row);
  return line ? <p className="text-xs text-muted-foreground" data-testid="request-plan-b"><LtrText text={line} /></p> : null;
}
