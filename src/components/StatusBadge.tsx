import {
  Ban,
  CheckCheck,
  CheckCircle2,
  Clock,
  ExternalLink,
  MessageCircleQuestion,
  PencilLine,
  Send,
  SendHorizontal,
  ThumbsDown,
  ThumbsUp,
  TimerOff,
  Users,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { he } from "@/i18n/he";
import { cn } from "@/lib/utils";

import type { Database } from "@/integrations/supabase/types";

type RequestStatus = Database["public"]["Enums"]["request_status"];
type ProposalStatus = Database["public"]["Enums"]["proposal_status"];
type RideStatus = Database["public"]["Enums"]["ride_status"];

interface StatusMeta {
  icon: LucideIcon;
  label: string;
  /** Tailwind text color token from the UX_FLOWS.md §7.4 legend. */
  colorClass: string;
  strikethrough?: boolean;
}

/**
 * `Record<RequestStatus, StatusMeta>` — a plain TS object type, so a
 * request_status value missing from this map (or added to the enum and not
 * added here) fails `npm run typecheck`. That's the exhaustiveness check
 * against the generated `Database["public"]["Enums"]` the component owns;
 * `StatusBadge.test.tsx` additionally renders every literal value at
 * runtime as a belt-and-suspenders check. Colors/icons/labels per
 * UX_FLOWS.md §7.4.
 */
const REQUEST_STATUS_META: Record<RequestStatus, StatusMeta> = {
  draft: { icon: PencilLine, label: he.status.draft, colorClass: "text-slate-500" },
  submitted: { icon: Send, label: he.status.submitted, colorClass: "text-slate-500" },
  proposed: {
    icon: MessageCircleQuestion,
    label: he.status.proposed,
    colorClass: "text-amber-500",
  },
  assigned: { icon: CheckCircle2, label: he.status.assigned, colorClass: "text-green-600" },
  merged: { icon: Users, label: he.status.merged, colorClass: "text-teal-600" },
  waitlisted: { icon: Clock, label: he.status.waitlisted, colorClass: "text-slate-400" },
  denied: { icon: XCircle, label: he.status.denied, colorClass: "text-red-600" },
  external: { icon: ExternalLink, label: he.status.external, colorClass: "text-violet-600" },
  withdrawn: {
    icon: Ban,
    label: he.status.withdrawn,
    colorClass: "text-slate-400",
    strikethrough: true,
  },
  cancelled: {
    icon: Ban,
    label: he.status.cancelled,
    colorClass: "text-slate-400",
    strikethrough: true,
  },
};

const PROPOSAL_STATUS_META: Record<ProposalStatus, StatusMeta> = {
  draft: { icon: PencilLine, label: he.proposalStatus.draft, colorClass: "text-slate-500" },
  sent: { icon: SendHorizontal, label: he.proposalStatus.sent, colorClass: "text-amber-500" },
  accepted: { icon: ThumbsUp, label: he.proposalStatus.accepted, colorClass: "text-green-600" },
  declined: { icon: ThumbsDown, label: he.proposalStatus.declined, colorClass: "text-red-600" },
  expired: { icon: TimerOff, label: he.proposalStatus.expired, colorClass: "text-slate-400" },
  withdrawn: {
    icon: Ban,
    label: he.proposalStatus.withdrawn,
    colorClass: "text-slate-400",
    strikethrough: true,
  },
  applied: { icon: CheckCheck, label: he.proposalStatus.applied, colorClass: "text-green-700" },
};

const RIDE_STATUS_META: Record<RideStatus, StatusMeta> = {
  draft: { icon: PencilLine, label: he.rideStatus.draft, colorClass: "text-slate-500" },
  confirmed: {
    icon: CheckCircle2,
    label: he.rideStatus.confirmed,
    colorClass: "text-green-600",
  },
  flagged: { icon: XCircle, label: he.rideStatus.flagged, colorClass: "text-orange-500" },
  cancelled: {
    icon: Ban,
    label: he.rideStatus.cancelled,
    colorClass: "text-slate-400",
    strikethrough: true,
  },
};

type StatusBadgeProps =
  | { kind: "request"; status: RequestStatus; className?: string }
  | { kind: "proposal"; status: ProposalStatus; className?: string }
  | { kind: "ride"; status: RideStatus; className?: string };

/**
 * Color + icon + Hebrew text, never color alone (UX_FLOWS.md §7.3/§7.4).
 * `kind` picks which status domain `status` belongs to (request, ride or
 * proposal — the three DB enums this component covers per the task brief).
 */
function metaFor(props: StatusBadgeProps): StatusMeta {
  switch (props.kind) {
    case "request":
      return REQUEST_STATUS_META[props.status];
    case "proposal":
      return PROPOSAL_STATUS_META[props.status];
    case "ride":
      return RIDE_STATUS_META[props.status];
  }
}

export function StatusBadge(props: StatusBadgeProps) {
  const meta = metaFor(props);
  const Icon = meta.icon;
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 border-current font-normal", meta.colorClass, props.className)}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      <span className={cn(meta.strikethrough && "line-through")}>{meta.label}</span>
    </Badge>
  );
}

export { REQUEST_STATUS_META, PROPOSAL_STATUS_META, RIDE_STATUS_META };
