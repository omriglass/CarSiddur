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
import { useDepartments } from "@/features/siddur/hooks";
import { he, tv } from "@/i18n/he";
import { showErrorToast } from "@/lib/rpc";
import { ruleRegistry, type RuleType } from "@/solver";

import { useRideTypesAdmin } from "../../rideTypes/hooks";
import type { PolicyRuleConfig } from "../api";
import {
  useCreatePolicyVersionMutation,
  usePoliciesAdmin,
  usePolicyVersions,
  useSetPolicyActiveMutation,
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

function buildDraft(existingRules: PolicyRuleConfig[]): DraftRule[] {
  const byType = new Map(existingRules.map((r) => [r.type, r]));
  return RULE_TYPES.map((type) => {
    const existing = byType.get(type);
    const rule = ruleRegistry[type];
    return {
      type,
      enabled: !!existing,
      weight: existing?.weight ?? 1,
      params: (existing?.params ?? rule.defaultParams) as Record<string, unknown>,
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
  const departmentsQuery = useDepartments();
  const rideTypesQuery = useRideTypesAdmin();
  const versionsQuery = usePolicyVersions(policyId);
  const createVersionMutation = useCreatePolicyVersionMutation();
  const setActiveMutation = useSetPolicyActiveMutation();

  const policy = (policiesQuery.data ?? []).find((p) => p.id === policyId);
  const latestVersion = versionsQuery.data?.[0];
  const rideTypeLabels = Object.fromEntries((rideTypesQuery.data ?? []).map((rt) => [rt.code, rt.name_he]));

  const [draft, setDraft] = useState<DraftRule[]>(() => buildDraft((latestVersion?.rules as unknown as PolicyRuleConfig[]) ?? []));
  const [initializedFor, setInitializedFor] = useState<string | undefined>(latestVersion?.id);
  if (versionsQuery.data && latestVersion?.id !== initializedFor && !versionsQuery.isFetching) {
    setInitializedFor(latestVersion?.id);
    setDraft(buildDraft((latestVersion?.rules as unknown as PolicyRuleConfig[]) ?? []));
  }

  const [note, setNote] = useState("");
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

      <Tabs defaultValue="editor">
        <TabsList>
          <TabsTrigger value="editor">{he.adminPolicy.editorTab}</TabsTrigger>
          <TabsTrigger value="history">{he.adminPolicy.historyTab}</TabsTrigger>
        </TabsList>

        <TabsContent value="editor" className="flex flex-col gap-4">
          {draft.map((row) => (
            <div key={row.type} className="flex flex-col gap-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-4">
                <Checkbox checked={row.enabled} onCheckedChange={(v) => updateRule(row.type, { enabled: !!v })} />
                <span className="font-medium">{row.type}</span>
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
    </div>
  );
}

export function PolicyEditorScreen() {
  const { id } = useParams();
  if (!id) return null;
  return <PolicyEditorInner key={id} policyId={id} />;
}
