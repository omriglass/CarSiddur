import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MaintenancePeriodDialog, type MaintenancePeriodDialogTarget } from "@/features/fleet/components/MaintenancePeriodDialog";
import { he } from "@/i18n/he";
import { formatInTimeZone } from "date-fns-tz";
import { TZ } from "@/lib/time";
import { showErrorToast } from "@/lib/rpc";

import { useCarIssues, useCarsAdmin, useResolveCarIssueMutation } from "../hooks";
import { useAllProfiles } from "../../members/hooks";

export function IssuesScreen() {
  const issuesQuery = useCarIssues();
  const carsQuery = useCarsAdmin();
  const profilesQuery = useAllProfiles();
  const resolveMutation = useResolveCarIssueMutation();
  const [moveTarget, setMoveTarget] = useState<MaintenancePeriodDialogTarget | null>(null);

  const carsById = new Map((carsQuery.data ?? []).map((c) => [c.id, c.name]));
  const profilesById = new Map((profilesQuery.data ?? []).map((p) => [p.id, p.full_name]));
  const openIssues = (issuesQuery.data ?? []).filter((i) => i.status === "open");

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <PageHeader title={he.screen.admin.issues} subtitle={he.adminIssues.subtitle} />

      {openIssues.length === 0 ? (
        <EmptyState icon={AlertTriangle} message={he.adminIssues.empty} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{he.adminIssues.columnCar}</TableHead>
              <TableHead>{he.adminIssues.columnReportedBy}</TableHead>
              <TableHead>{he.adminIssues.columnDescription}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {openIssues.map((issue) => (
              <TableRow key={issue.id}>
                <TableCell>{carsById.get(issue.car_id) ?? issue.car_id}</TableCell>
                <TableCell>{profilesById.get(issue.reported_by) ?? issue.reported_by}</TableCell>
                <TableCell>
                  {issue.description}
                  {issue.is_unsafe ? (
                    <Badge variant="destructive" className="ms-2">
                      {he.adminIssues.unsafe}
                    </Badge>
                  ) : null}
                  <div className="text-xs text-muted-foreground" dir="ltr">
                    {formatInTimeZone(new Date(issue.created_at), TZ, "dd/MM/yyyy HH:mm")}
                  </div>
                </TableCell>
                <TableCell className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      try {
                        await resolveMutation.mutateAsync(issue.id);
                        toast.success(he.adminCommon.savedToast);
                      } catch (error) {
                        showErrorToast(error);
                      }
                    }}
                  >
                    {he.adminIssues.resolve}
                  </Button>
                  <Button size="sm" onClick={() => setMoveTarget({ mode: "unsafe", carName: carsById.get(issue.car_id) ?? "", issueId: issue.id })}>
                    {he.action.moveToMaintenance}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <MaintenancePeriodDialog target={moveTarget} onOpenChange={(open) => !open && setMoveTarget(null)} />
    </div>
  );
}
