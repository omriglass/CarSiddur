import { he, tv } from "@/i18n/he";

import { ruleColor, ruleHow, ruleName, ruleSummary, type RuleSlice } from "../ruleExplain";

interface RuleDetailsProps {
  slice: RuleSlice;
  rideTypeNames: Readonly<Record<string, string>>;
}

/** One rule explained (REQ §13.133): what it favours, how its 0..1 value is calculated, and what its weight means. */
export function RuleDetails({ slice, rideTypeNames }: RuleDetailsProps) {
  const { rule } = slice;
  const percent = String(Math.round(slice.fraction * 100));
  const weight = String(Math.round(rule.weight * 100) / 100);
  const summary = ruleSummary(rule.type);
  return (
    <section className="space-y-2 rounded-md border p-3 text-sm" data-testid={`policy-rule-${rule.type}`}>
      <div className="flex items-center gap-2">
        <span className="size-3 shrink-0 rounded-full" style={{ background: ruleColor(rule.type) }} aria-hidden="true" />
        <h3 className="flex-1 font-semibold">{ruleName(rule.type)}</h3>
        <span className="shrink-0 text-xs text-muted-foreground">
          {tv("policyView.weight", { weight })} · <span dir="ltr">{tv("policyView.share", { percent })}</span>
        </span>
      </div>
      {summary ? <p>{summary}</p> : null}
      <div className="space-y-1 rounded-md bg-muted/50 p-2">
        <p className="text-xs font-medium text-muted-foreground">{he.policyView.howTitle}</p>
        <p>{ruleHow(rule, rideTypeNames)}</p>
        <p className="text-xs text-muted-foreground">{tv("policyView.contribution", { weight, percent })}</p>
      </div>
    </section>
  );
}
