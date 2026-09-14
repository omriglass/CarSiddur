import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import type { CarIssueStatus, CarStatus, ProposalStatus, RequestStatus, RideStatus, WeekPhase } from "@/lib/enums";
import { metaFor, type InviteRowStatus } from "./statusBadgeMeta";

export type StatusBadgeProps =
  | { kind: "request"; status: RequestStatus; className?: string }
  | { kind: "proposal"; status: ProposalStatus; className?: string }
  | { kind: "ride"; status: RideStatus; className?: string }
  | { kind: "car"; status: CarStatus; className?: string }
  | { kind: "week"; status: WeekPhase; className?: string }
  | { kind: "carIssue"; status: CarIssueStatus; className?: string }
  | { kind: "inviteRow"; status: InviteRowStatus; className?: string };

export function StatusBadge(props: StatusBadgeProps) {
  const meta = metaFor(props);
  const Icon = meta.icon;
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 font-medium transition-smooth", meta.colorClass, props.className)}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      <span className={cn(meta.strikethrough && "line-through")}>{meta.label}</span>
    </Badge>
  );
}
