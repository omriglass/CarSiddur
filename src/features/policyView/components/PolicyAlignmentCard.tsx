import { formatWeekRangeLabel } from "@/components/dateFieldDates";
import { he, tv } from "@/i18n/he";

import { usePolicyAlignmentQuery } from "../hooks";

/**
 * "How closely did the latest published week follow this policy?" (REQ §13.133, owner 2026-10-13): of the
 * pairs of requests that competed for a car, how many were decided the way this policy ranks them
 * (`policy_week_alignment`). Comparable across policies — 50% is a coin toss, 100% a full match —
 * unlike the weighted coverage, which also depends on how many requests got a car at all.
 */
export function PolicyAlignmentCard({ policyId }: { policyId: string }) {
  const query = usePolicyAlignmentQuery(policyId);
  if (query.isLoading) return <div className="h-16 animate-pulse rounded-md bg-muted" />;
  if (query.isError) return null;
  const alignment = query.data ?? null;
  const decided = alignment ? alignment.followed + alignment.reversed : 0;
  const percent = decided ? Math.round((alignment!.followed / decided) * 100) : 0;
  return (
    <section className="space-y-2 rounded-md border p-3 text-sm" data-testid="policy-alignment">
      <h2 className="font-semibold">{he.policyView.alignmentTitle}</h2>
      {!alignment ? (
        <p className="text-muted-foreground">{he.policyView.alignmentNone}</p>
      ) : decided === 0 ? (
        <p className="text-muted-foreground">
          {tv("policyView.alignmentNoPairs", { week: formatWeekRangeLabel(alignment.weekStart) })}
          {alignment.tied ? ` ${tv("policyView.alignmentTied", { count: String(alignment.tied) })}` : null}
        </p>
      ) : (
        <>
          <p>
            {tv("policyView.alignmentLine", {
              week: formatWeekRangeLabel(alignment.weekStart),
              followed: String(alignment.followed),
              decided: String(decided),
              percent: String(percent),
            })}
            {alignment.tied ? ` ${tv("policyView.alignmentTied", { count: String(alignment.tied) })}` : null}
          </p>
          <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
          </div>
        </>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">{he.policyView.alignmentExplainSummary}</summary>
        <p className="pt-1">{he.policyView.alignmentExplain}</p>
      </details>
    </section>
  );
}
