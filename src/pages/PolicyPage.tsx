import { useState } from "react";
import { useParams } from "react-router-dom";

import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { CardListSkeleton } from "@/components/skeletons/CardListSkeleton";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useRideTypes } from "@/features/fleet/hooks";
import { PolicyAlignmentCard } from "@/features/policyView/components/PolicyAlignmentCard";
import { PolicyPie } from "@/features/policyView/components/PolicyPie";
import { RuleDetails } from "@/features/policyView/components/RuleDetails";
import { useDepartmentPoliciesQuery } from "@/features/policyView/hooks";
import { ruleSlices } from "@/features/policyView/ruleExplain";
import { he, tv } from "@/i18n/he";
import { Scale } from "lucide-react";

/**
 * `/policy/:dept` — "הצג מדיניות" (REQ §13.133, owner 2026-10-13): any member reads how the department's
 * policies rank requests. A policy selector (the active one first by default), each showing its current
 * version as a pie (tap a slice: it moves out and its calculation shows) or as a list, plus how closely
 * the latest published week followed it. Read-only; reached from the siddur's eye menu.
 */
export function PolicyPage() {
  const { dept } = useParams<{ dept: string }>();
  const policiesQuery = useDepartmentPoliciesQuery(dept);
  const rideTypesQuery = useRideTypes(dept);
  const [chosenPolicyId, setChosenPolicyId] = useState<string | null>(null);
  const [view, setView] = useState<"pie" | "list">("pie");
  const [selectedRule, setSelectedRule] = useState<string | null>(null);

  const policies = policiesQuery.data ?? [];
  const policy = policies.find((p) => p.id === chosenPolicyId) ?? policies.find((p) => p.isActive) ?? policies[0] ?? null;
  const slices = policy ? ruleSlices(policy.rules) : [];
  const selectedSlice = slices.find((slice) => slice.rule.type === selectedRule) ?? null;
  const rideTypeNames = Object.fromEntries((rideTypesQuery.data ?? []).map((type) => [type.code, type.name_he]));

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 pb-24">
      <PageHeader title={he.policyView.title} subtitle={he.policyView.intro} />
      {policiesQuery.isLoading ? (
        <CardListSkeleton count={2} />
      ) : policiesQuery.isError ? (
        <ErrorState onRetry={() => void policiesQuery.refetch()} />
      ) : !policy ? (
        <EmptyState icon={Scale} message={he.policyView.noPolicies} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {policies.length > 1 ? (
              <Select value={policy.id} onValueChange={(id) => { setChosenPolicyId(id); setSelectedRule(null); }}>
                <SelectTrigger className="min-h-11 w-56" aria-label={he.policyView.policyLabel} data-testid="policy-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {policies.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.isActive ? `${p.name} · ${he.policyView.activeBadge}` : p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="font-semibold">{policy.name}</span>
            )}
            {policies.length === 1 && policy.isActive ? <Badge variant="outline">{he.policyView.activeBadge}</Badge> : null}
            {policy.versionNo != null ? <span className="text-xs text-muted-foreground">{tv("policyView.version", { n: String(policy.versionNo) })}</span> : null}
            <ToggleGroup
              type="single"
              value={view}
              onValueChange={(next) => { if (next) setView(next as "pie" | "list"); }}
              className="ms-auto rounded-full bg-muted p-0.5"
              aria-label={he.policyView.viewToggle}
            >
              <ToggleGroupItem value="pie" className="h-8 rounded-full px-3 text-sm data-[state=on]:bg-background data-[state=on]:shadow-sm" data-testid="policy-view-pie">{he.policyView.viewPie}</ToggleGroupItem>
              <ToggleGroupItem value="list" className="h-8 rounded-full px-3 text-sm data-[state=on]:bg-background data-[state=on]:shadow-sm" data-testid="policy-view-list">{he.policyView.viewList}</ToggleGroupItem>
            </ToggleGroup>
          </div>

          {slices.length === 0 ? (
            <p className="text-sm text-muted-foreground">{he.policyView.noRules}</p>
          ) : view === "pie" ? (
            <PolicyPie
              slices={slices}
              selected={selectedRule}
              onSelect={setSelectedRule}
              details={selectedSlice
                ? <RuleDetails slice={selectedSlice} rideTypeNames={rideTypeNames} />
                : <p className="text-center text-xs text-muted-foreground">{he.policyView.pieHint}</p>}
            />
          ) : (
            <div className="space-y-2" data-testid="policy-rule-list">
              {slices.map((slice) => <RuleDetails key={slice.rule.type} slice={slice} rideTypeNames={rideTypeNames} />)}
            </div>
          )}

          <PolicyAlignmentCard policyId={policy.id} />
        </>
      )}
    </div>
  );
}
