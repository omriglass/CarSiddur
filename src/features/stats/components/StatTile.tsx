import type { ReactNode } from "react";

import { Card, CardContent } from "@/components/ui/card";

interface StatTileProps {
  label: string;
  /** The headline value — already wrapped by the caller in `<span dir="ltr">` where it's numeric. */
  value: ReactNode;
  sub?: ReactNode;
  help: string;
  /**
   * An extra one-line note under `help`, e.g. the utilization tile's capacity
   * formula (`he.stats.capacityFormula`) — so a number is never a mystery
   * (owner feedback, UX_FLOWS.md §5.12).
   */
  footnote?: string;
  testId?: string;
}

/** One stat tile of the statistics screen's 2/4-column grid (UX_FLOWS.md §5.12). */
export function StatTile({ label, value, sub, help, footnote, testId }: StatTileProps) {
  return (
    <Card className="bg-gradient-card shadow-card" data-testid={testId}>
      <CardContent className="space-y-1 p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold text-foreground">{value}</p>
        {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
        <p className="text-[11px] leading-snug text-muted-foreground/80">{help}</p>
        {footnote ? <p className="text-[11px] leading-snug text-muted-foreground/60">{footnote}</p> : null}
      </CardContent>
    </Card>
  );
}
