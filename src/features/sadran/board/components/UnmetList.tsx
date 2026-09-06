import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { he, tv } from "@/i18n/he";

import type { RequestRow } from "../../api";
import type { Suggestion, UnmetRequest } from "@/solver";

export interface UnmetListItem {
  request: RequestRow;
  destinationName: string;
  /** Present only once a client-side solve has run this session (SOLVER.md §2 `UnmetRequest`). */
  solverInfo?: UnmetRequest;
}

interface UnmetListProps {
  items: readonly UnmetListItem[];
  onAction: (item: UnmetListItem, suggestion: Suggestion | null) => void;
}

function suggestionActionLabel(kind: Suggestion["kind"]): string {
  switch (kind) {
    case "shiftWithinFlex":
      return he.action.apply;
    case "merge":
    case "shiftBeyondFlex":
    case "splitLegs":
    case "convertToRoundTrip":
      return he.action.propose;
    case "chauffeur":
      return he.action.propose;
    case "externalHint":
      return he.action.markExternal;
    case "deny":
      return he.action.deny;
  }
}

/** Side panel `UnmetList` (UX_FLOWS.md §4.2): sorted by score, one-tap action per suggestion (SOLVER.md §3.15). */
export function UnmetList({ items, onAction }: UnmetListProps) {
  const sorted = [...items].sort((a, b) => (b.solverInfo?.score ?? 0) - (a.solverInfo?.score ?? 0));

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium">{tv("sadranBoard.unmetTitle", { count: String(items.length) })}</h2>
      {sorted.map((item) => (
        <Card key={item.request.id}>
          <CardContent className="space-y-2 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium">{item.destinationName}</span>
              {item.solverInfo ? (
                <span className="text-xs text-muted-foreground" dir="ltr">
                  {he.sadranBoard.scoreLabel} {item.solverInfo.score.toFixed(2)}
                </span>
              ) : null}
            </div>
            {item.request.is_late ? <span className="text-xs text-orange-600">{he.flag.late}</span> : null}
            {item.request.changed_since_solve ? <span className="text-xs text-blue-600">{he.flag.changed}</span> : null}
            {item.solverInfo?.reason ? <p className="text-xs text-muted-foreground">{item.solverInfo.reason}</p> : null}

            <div className="space-y-1">
              {item.solverInfo && item.solverInfo.suggestions.length > 0 ? (
                item.solverInfo.suggestions.map((s, i) => (
                  <div key={i} className="flex items-center justify-between gap-2">
                    <span className="text-xs">{s.reason}</span>
                    <Button size="sm" variant="outline" onClick={() => onAction(item, s)}>
                      {suggestionActionLabel(s.kind)}
                    </Button>
                  </div>
                ))
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">{he.sadranBoard.noSuggestions}</span>
                  <Button size="sm" variant="outline" onClick={() => onAction(item, null)}>
                    {he.action.propose}
                  </Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
