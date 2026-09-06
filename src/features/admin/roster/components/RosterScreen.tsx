import { addDays, format, parseISO } from "date-fns";
import { useMemo, useState } from "react";

import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCurrentWeekStart, useDepartments } from "@/features/siddur/hooks";
import { he, tv } from "@/i18n/he";
import { cn } from "@/lib/utils";
import { showErrorToast } from "@/lib/rpc";
import { toast } from "sonner";

import { useAllDepartmentMembers, useAllProfiles } from "../../members/hooks";
import { useSadranAssignments, useSetStandingDefaultMutation, useSetWeekAssignmentsMutation } from "../hooks";

const WEEK_COUNT = 12;

interface CellTarget {
  departmentId: string;
  departmentName: string;
  weekStart: string | null; // null = standing default column
}

export function RosterScreen() {
  const currentWeekQuery = useCurrentWeekStart();
  const departmentsQuery = useDepartments();
  const profilesQuery = useAllProfiles();
  const deptMembersQuery = useAllDepartmentMembers();

  const weekStarts = useMemo(() => {
    if (!currentWeekQuery.data) return [];
    const base = parseISO(currentWeekQuery.data);
    return Array.from({ length: WEEK_COUNT }, (_, i) => format(addDays(base, i * 7), "yyyy-MM-dd"));
  }, [currentWeekQuery.data]);

  const assignmentsQuery = useSadranAssignments(weekStarts);
  const setWeekMutation = useSetWeekAssignmentsMutation();
  const setStandingMutation = useSetStandingDefaultMutation();

  const [target, setTarget] = useState<CellTarget | null>(null);
  const [draft, setDraft] = useState<Set<string>>(new Set());

  const profilesById = useMemo(() => new Map((profilesQuery.data ?? []).map((p) => [p.id, p])), [profilesQuery.data]);

  const membersByDept = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const dm of deptMembersQuery.data ?? []) {
      const list = map.get(dm.department_id) ?? [];
      list.push(dm.profile_id);
      map.set(dm.department_id, list);
    }
    return map;
  }, [deptMembersQuery.data]);

  function explicitFor(departmentId: string, weekStart: string | null): string[] {
    return (assignmentsQuery.data ?? [])
      .filter((a) => a.department_id === departmentId && a.week_start === weekStart)
      .map((a) => a.profile_id);
  }

  function effectiveFor(departmentId: string, weekStart: string): { ids: string[]; isStanding: boolean } {
    const explicit = explicitFor(departmentId, weekStart);
    if (explicit.length > 0) return { ids: explicit, isStanding: false };
    return { ids: explicitFor(departmentId, null), isStanding: true };
  }

  function openCell(departmentId: string, departmentName: string, weekStart: string | null) {
    const current = explicitFor(departmentId, weekStart);
    setDraft(new Set(current));
    setTarget({ departmentId, departmentName, weekStart });
  }

  async function saveCell() {
    if (!target) return;
    try {
      if (target.weekStart === null) {
        await setStandingMutation.mutateAsync({ departmentId: target.departmentId, profileIds: [...draft] });
      } else {
        await setWeekMutation.mutateAsync({
          departmentId: target.departmentId,
          weekStart: target.weekStart,
          profileIds: [...draft],
        });
      }
      toast.success(he.adminCommon.savedToast);
      setTarget(null);
    } catch (error) {
      showErrorToast(error);
    }
  }

  const departments = departmentsQuery.data ?? [];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <PageHeader title={he.screen.admin.roster} subtitle={he.adminRoster.subtitle} />

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr>
              <th className="border-b p-2 text-start">{he.adminRoster.columnWeek}</th>
              {departments.map((dept) => (
                <th key={dept.id} className="border-b p-2 text-start">
                  <div>{dept.name}</div>
                  <button
                    type="button"
                    className="text-xs font-normal text-muted-foreground underline"
                    onClick={() => openCell(dept.id, dept.name, null)}
                  >
                    {he.adminRoster.standingDefault}:{" "}
                    {explicitFor(dept.id, null)
                      .map((id) => profilesById.get(id)?.full_name ?? id)
                      .join(", ") || "—"}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weekStarts.map((weekStart, weekIndex) => (
              <tr key={weekStart}>
                <td className="border-b p-2 font-medium" dir="ltr">
                  {weekStart}
                </td>
                {departments.map((dept) => {
                  const { ids, isStanding } = effectiveFor(dept.id, weekStart);
                  const isSoon = weekIndex < 2 && ids.length === 0;
                  return (
                    <td
                      key={dept.id}
                      className={cn("cursor-pointer border-b p-2", isSoon && "bg-amber-100 dark:bg-amber-950")}
                      onClick={() => openCell(dept.id, dept.name, weekStart)}
                    >
                      {ids.length === 0 ? (
                        <span className={cn(isSoon && "font-medium text-amber-700 dark:text-amber-300")}>
                          {isSoon ? he.adminRoster.noSadranWarning : "—"}
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {ids.map((id) => (
                            <Badge key={id} variant={isStanding ? "outline" : "default"}>
                              {profilesById.get(id)?.full_name ?? id}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={!!target} onOpenChange={(open) => !open && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {target?.weekStart === null
                ? tv("adminRoster.editStandingTitle", { dept: target?.departmentName ?? "" })
                : tv("adminRoster.editCellTitle", {
                    dept: target?.departmentName ?? "",
                    week: target?.weekStart ?? "",
                  })}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">{he.adminRoster.pickMembers}</p>
            {(membersByDept.get(target?.departmentId ?? "") ?? []).map((profileId) => (
              <label key={profileId} className="flex items-center gap-2">
                <Checkbox
                  checked={draft.has(profileId)}
                  onCheckedChange={(checked) => {
                    setDraft((prev) => {
                      const next = new Set(prev);
                      if (checked) next.add(profileId);
                      else next.delete(profileId);
                      return next;
                    });
                  }}
                />
                {profilesById.get(profileId)?.full_name ?? profileId}
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>
              {he.adminCommon.cancel}
            </Button>
            <Button onClick={saveCell}>{he.adminCommon.save}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
