import { History } from "lucide-react";

import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { he } from "@/i18n/he";
import { describeStatusReason } from "@/lib/statusReason";
import { formatTime } from "@/lib/time";

import { useAuditLog } from "../../hooks";

interface ChangeLogScreenProps {
  departmentId: string;
  weekStart: string;
}

const ENTITY_LABEL: Record<string, string> = {
  requests: he.sadranLog.entityRequest,
  rides: he.sadranLog.entityRide,
  proposals: he.sadranLog.entityProposal,
  cars: he.sadranLog.entityCar,
  destinations: he.sadranLog.entityDestination,
};

const ACTOR_LABEL: Record<string, string> = {
  member: he.sadranLog.actorMember,
  sadran: he.sadranLog.actorSadran,
  admin: he.sadranLog.actorAdmin,
  system: he.sadranLog.actorSystem,
};

/** `/sadran/:dept/:week/log` — change log (UX_FLOWS.md §4.6, `ChangeLogList`). */
export function ChangeLogScreen({ departmentId, weekStart }: ChangeLogScreenProps) {
  const auditLogQuery = useAuditLog(departmentId, weekStart);
  const entries = auditLogQuery.data ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-4 pb-24">
      <PageHeader title={he.screen.log.title} />

      {entries.length === 0 ? (
        <EmptyState icon={History} message={he.sadranLog.empty} />
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <Card key={entry.id}>
              <CardContent className="space-y-1 p-3 text-sm">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span dir="ltr">{formatTime(new Date(entry.at))}</span>
                  <span>{ACTOR_LABEL[entry.actor_role ?? "system"] ?? entry.actor_role ?? he.sadranLog.actorSystem}</span>
                </div>
                <div className="font-medium">
                  {ENTITY_LABEL[entry.table_name] ?? entry.table_name} · {entry.action}
                </div>
                {entry.reason ? (
                  <p className="text-xs text-muted-foreground">{describeStatusReason(entry.reason)}</p>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
