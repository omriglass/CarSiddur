import { useState } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";

import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useOperationalDepartments } from "@/features/admin/useOperations";
import { he, tv } from "@/i18n/he";
import { showErrorToast } from "@/lib/rpc";
import { ruleRegistry, type RuleType } from "@/solver";
import { Info } from "lucide-react";

import { useRideTypesAdmin } from "../../rideTypes/hooks";
import type { PolicyRuleConfig } from "../api";
import {
  useCreatePolicyVersionMutation,
  usePoliciesAdmin,
  usePolicyVersions,
  useSetPolicyActiveMutation,
  useUpdatePolicyNameMutation,
} from "../hooks";
import { runPolicyPreview, type PolicyPreviewResult } from "../preview";
import { RuleParamsEditor } from "./RuleParamsEditor";

interface DraftRule {
  type: RuleType;
  enabled: boolean;
  weight: number;
  params: Record<string, unknown>;
}

const RULE_TYPES = Object.keys(ruleRegistry) as RuleType[];

const RIDETYPE_DEFAULT_WEIGHT_FALLBACK = 5;

/** Ensures `rideType.weights` has an entry for every ride type code currently in the DB, seeded with
 * `weights[code] ?? defaultWeight` (task requirement: saved params must include every existing code).
 * Codes no longer in the DB are left in place (shown greyed/removable by the caller) — never dropped here. */
function withAllRideTypeCodes(raw: Record<string, unknown>, codes: string[]): Record<string, unknown> {
  const weights = { ...((raw.weights as Record<string, number> | undefined) ?? {}) };
  const defaultWeight = typeof raw.defaultWeight === "number" ? raw.defaultWeight : RIDETYPE_DEFAULT_WEIGHT_FALLBACK;
  for (const code of codes) {
    if (!(code in weights)) weights[code] = defaultWeight;
  }
  return { ...raw, weights, defaultWeight };
}

function buildDraft(existingRules: PolicyRuleConfig[], rideTypeCodes: string[]): DraftRule[] {
  const byType = new Map(existingRules.map((r) => [r.type, r]));
  return RULE_TYPES.map((type) => {
    const existing = byType.get(type);
    const rule = ruleRegistry[type];
    const rawParams = (existing?.params ?? rule.defaultParams) as Record<string, unknown>;
    const params = type === "rideType" ? withAllRideTypeCodes(rawParams, rideTypeCodes) : rawParams;
    return {
      type,
      enabled: !!existing,
      weight: existing?.weight ?? 1,
      params,
    };
  });
}

function describeRule(type: RuleType, params: Record<string, unknown>): string {
  try {
    const rule = ruleRegistry[type];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous Rule<P>, validated at runtime
    return rule.describe(rule.validateParams(params) as any);
  } catch {
    return he.adminPolicy.paramsInvalid;
  }
}

function PolicyEditorInner({ policyId }: { policyId: string }) {
  const policiesQuery = usePoliciesAdmin();
  const departmentsQuery = useOperationalDepartments();
  const rideTypesQuery = useRideTypesAdmin();
  const versionsQuery = usePolicyVersions(policyId);
  const createVersionMutation = useCreatePolicyVersionMutation();
  const setActiveMutation = useSetPolicyActiveMutation();
  const updateNameMutation = useUpdatePolicyNameMutation();

  const policy = (policiesQuery.data ?? []).find((p) => p.id === policyId && departmentsQuery.data?.some((department) => department.id === p.department_id));
  const latestVersion = versionsQuery.data?.[0];
  const rideTypeCodes = (rideTypesQuery.data ?? []).map((rt) => rt.code);
  const rideTypeLabels = Object.fromEntries((rideTypesQuery.data ?? []).map((rt) => [rt.code, rt.name_he]));

  const [draft, setDraft] = useState<DraftRule[]>(() =>
    buildDraft((latestVersion?.rules as unknown as PolicyRuleConfig[]) ?? [], rideTypeCodes),
  );
  const [initializedFor, setInitializedFor] = useState<string | undefined>(latestVersion?.id);
  if (versionsQuery.data && latestVersion?.id !== initializedFor && !versionsQuery.isFetching) {
    setInitializedFor(latestVersion?.id);
    setDraft(buildDraft((latestVersion?.rules as unknown as PolicyRuleConfig[]) ?? [], rideTypeCodes));
  }

  // Ride types load asynchronously (and may change while the editor is open); once loaded, make sure
  // every current code has a weight without waiting for the user to touch the field (task requirement:
  // the saved params must include every existing ride type code).
  const rideTypeCodesKey = rideTypeCodes.slice().sort().join(",");
  const [seededForCodes, setSeededForCodes] = useState("");
  if (rideTypeCodes.length > 0 && rideTypeCodesKey !== seededForCodes) {
    setSeededForCodes(rideTypeCodesKey);
    setDraft((rows) =>
      rows.map((r) => (r.type === "rideType" ? { ...r, params: withAllRideTypeCodes(r.params, rideTypeCodes) } : r)),
    );
  }

  const [note, setNote] = useState("");
  const [policyName, setPolicyName] = useState("");
  const [policyNameFor, setPolicyNameFor] = useState<string | undefined>();
  if (policy && policy.id !== policyNameFor) {
    setPolicyNameFor(policy.id);
    setPolicyName(policy.name);
  }
  const [testDepartmentId, setTestDepartmentId] = useState(policy?.department_id ?? "");
  const [preview, setPreview] = useState<PolicyPreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [showFlipsOnly, setShowFlipsOnly] = useState(false);

  function updateRule(type: RuleType, patch: Partial<DraftRule>) {
    setDraft((rows) => rows.map((r) => (r.type === type ? { ...r, ...patch } : r)));
  }

  function toRuleConfigs(rows: DraftRule[]): PolicyRuleConfig[] {
    return rows.filter((r) => r.enabled).map((r) => ({ type: r.type, weight: r.weight, params: r.params }));
  }

  async function handleSave() {
    if (!policy) return;
    try {
      await createVersionMutation.mutateAsync({ policyId: policy.id, rules: toRuleConfigs(draft), note: note || null });
      toast.success(he.adminCommon.savedToast);
      setNote("");
    } catch (error) {
      showErrorToast(error);
    }
  }

  async function handleActivate() {
    if (!policy) return;
    try {
      await setActiveMutation.mutateAsync({ policyId: policy.id, isActive: true });
      toast.success(he.adminCommon.savedToast);
    } catch (error) {
      showErrorToast(error);
    }
  }

  async function handleSaveName() {
    if (!policy || !policyName.trim() || policyName.trim() === policy.name) return;
    try {
      await updateNameMutation.mutateAsync({ policyId: policy.id, name: policyName });
      toast.success(he.adminCommon.savedToast);
    } catch (error) {
      showErrorToast(error);
    }
  }

  async function handleRunTest() {
    const department = (departmentsQuery.data ?? []).find((d) => d.id === testDepartmentId);
    if (!department?.home_destination_id) return;
    setPreviewLoading(true);
    try {
      const oldRules = (latestVersion?.rules as unknown as PolicyRuleConfig[]) ?? [];
      const result = await runPolicyPreview({
        departmentId: testDepartmentId,
        homeDestinationId: department.home_destination_id,
        oldRules,
        newRules: toRuleConfigs(draft),
      });
      setPreview(result);
      if (!result) toast.error(he.adminPolicy.noPreviousWeek);
    } catch (error) {
      showErrorToast(error);
    } finally {
      setPreviewLoading(false);
    }
  }

  if (!policy) return null;

  const nextVersionNo = (latestVersion?.version_no ?? 0) + 1;
  const visibleRankingRows = preview
    ? showFlipsOnly
      ? preview.rankingRows.filter((row) => preview.flips.some((f) => f.requestId === row.requestId))
      : preview.rankingRows
    : [];

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-4">
      <PageHeader
        title={policy.name}
        subtitle={
          latestVersion ? tv("adminPolicy.versionLabel", { n: String(latestVersion.version_no) }) : he.adminPolicy.empty
        }
        actions={<Button onClick={handleActivate}>{he.action.activateForDept}</Button>}
      />

      <TooltipProvider>
      <Tabs defaultValue="editor">
        <TabsList>
          <TabsTrigger value="editor">{he.adminPolicy.editorTab}</TabsTrigger>
          <TabsTrigger value="history">{he.adminPolicy.historyTab}</TabsTrigger>
        </TabsList>

        <TabsContent value="editor" className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-end">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
              {he.adminPolicy.name}
              <Input value={policyName} onChange={(event) => setPolicyName(event.target.value)} maxLength={100} />
            </label>
            <Button onClick={handleSaveName} disabled={!policyName.trim() || policyName.trim() === policy.name || updateNameMutation.isPending}>
              {he.adminPolicy.saveName}
            </Button>
          </div>
          {draft.map((row) => (
            <div key={row.type} className="flex flex-col gap-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-4">
                <Checkbox checked={row.enabled} onCheckedChange={(v) => updateRule(row.type, { enabled: !!v })} />
                <span className="flex items-center gap-1 font-medium">
                  {he.adminPolicy.ruleNames[row.type]}
                  <Tooltip>
                    <TooltipTrigger asChild><button type="button" aria-label={tv("adminPolicy.ruleInfoLabel", { rule: he.adminPolicy.ruleNames[row.type] })}><Info className="size-4 text-muted-foreground" /></button></TooltipTrigger>
                    <TooltipContent className="max-w-xs">{he.adminPolicy.ruleInfo[row.type]}</TooltipContent>
                  </Tooltip>
                </span>
                <span className="flex items-center gap-2 text-sm">
                  {he.adminPolicy.ruleWeight}
                  <Slider
                    className="w-40"
                    min={0}
                    max={10}
                    step={0.1}
                    value={[row.weight]}
                    onValueChange={([v]) => updateRule(row.type, { weight: v })}
                    disabled={!row.enabled}
                  />
                  <Input
                    type="number"
                    step={0.1}
                    className="w-20"
                    value={row.weight}
                    onChange={(e) => updateRule(row.type, { weight: Number(e.target.value) })}
                  />
                </span>
              </div>
              <RuleParamsEditor
                params={row.params}
                onChange={(params) => updateRule(row.type, { params })}
                keyLabels={row.type === "rideType" ? rideTypeLabels : undefined}
                paramLabels={he.adminPolicy.paramNames}
                staleNestedKeys={
                  row.type === "rideType" && rideTypeCodes.length > 0
                    ? {
                        weights: Object.keys((row.params.weights as Record<string, number> | undefined) ?? {}).filter(
                          (code) => !rideTypeCodes.includes(code),
                        ),
                      }
                    : undefined
                }
                staleHint={he.adminPolicy.rideTypeUnused}
                removeLabel={he.adminPolicy.rideTypeRemove}
              />
              <p className="text-xs text-muted-foreground">{describeRule(row.type, row.params)}</p>
            </div>
          ))}

          <div className="flex flex-col gap-2 border-t pt-4">
            <label className="flex flex-col gap-1 text-sm">
              {he.adminPolicy.versionNote}
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={he.adminPolicy.versionNotePlaceholder}
              />
            </label>
            <Button onClick={handleSave} className="self-start">
              {tv("action.saveAsVersion", { n: String(nextVersionNo) })}
            </Button>
          </div>

          <div className="flex flex-col gap-3 rounded-md border p-3">
            <h3 className="font-medium">{he.adminPolicy.testPanelTitle}</h3>
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={testDepartmentId}
                onChange={(e) => setTestDepartmentId(e.target.value)}
              >
                <option value="">{he.adminPolicy.department}</option>
                {(departmentsQuery.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <Button onClick={handleRunTest} disabled={!testDepartmentId || previewLoading}>
                {he.action.testLastWeek}
              </Button>
            </div>

            {preview ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {tv("adminPolicy.testPanelSubtitle", {
                    week: preview.weekStart,
                    dept: (departmentsQuery.data ?? []).find((d) => d.id === testDepartmentId)?.name ?? "",
                  })}
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{he.adminPolicy.columnRank}</TableHead>
                      <TableHead>{he.adminPolicy.columnRequest}</TableHead>
                      <TableHead>{he.adminPolicy.columnCurrentScore}</TableHead>
                      <TableHead>{he.adminPolicy.columnNewScore}</TableHead>
                      <TableHead>{he.adminPolicy.columnChange}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleRankingRows.map((row) => {
                      const flip = preview.flips.find((f) => f.requestId === row.requestId);
                      return (
                        <TableRow key={row.requestId}>
                          <TableCell dir="ltr">{row.newRank ?? "—"}</TableCell>
                          <TableCell dir="ltr">{row.requestId}</TableCell>
                          <TableCell dir="ltr">{row.currentScore?.toFixed(2) ?? "—"}</TableCell>
                          <TableCell dir="ltr">{row.newScore?.toFixed(2) ?? "—"}</TableCell>
                          <TableCell>
                            {flip ? (
                              <Badge variant={flip.direction === "unmetToServed" ? "default" : "destructive"}>
                                {flip.direction === "unmetToServed" ? "▲" : "▼"}
                              </Badge>
                            ) : row.rankDelta !== null ? (
                              row.rankDelta
                            ) : (
                              "—"
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                <div className="flex items-center gap-2">
                  <span className="text-sm">{tv("adminPolicy.flipCount", { count: String(preview.flips.length) })}</span>
                  <Button size="sm" variant="outline" onClick={() => setShowFlipsOnly((s) => !s)}>
                    {he.adminPolicy.showFlipsOnly}
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        </TabsContent>

        <TabsContent value="history">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{he.adminPolicy.versionColumn}</TableHead>
                <TableHead>{he.adminPolicy.versionNote}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(versionsQuery.data ?? []).map((v) => (
                <TableRow key={v.id}>
                  <TableCell dir="ltr">{v.version_no}</TableCell>
                  <TableCell>{v.note ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TabsContent>
      </Tabs>
      </TooltipProvider>
    </div>
  );
}

export function PolicyEditorScreen() {
  const { id } = useParams();
  if (!id) return null;
  return <PolicyEditorInner key={id} policyId={id} />;
}
