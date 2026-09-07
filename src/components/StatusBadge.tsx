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
  /**
   * Tailwind color token classes (text + tinted background + border), mapped
   * onto the shared semantic palette (visual pass): `booked` (primary blue)
   * for a placed/confirmed ride or request, `maintenance` (amber) for
   * anything awaiting an answer, `destructive` (muted red) for a denial or
   * cancellation, `available` (green) for a successful/accepted outcome, and
   * plain `muted` for neutral/inert states — never color alone, the icon and
   * Hebrew label always carry the meaning too (UX_FLOWS.md §7.4).
   */
  colorClass: string;
  strikethrough?: boolean;
}

const TONE = {
  booked: "text-booked bg-booked/10 border-booked/20",
  amber: "text-maintenance bg-maintenance/10 border-maintenance/20",
  destructive: "text-destructive bg-destructive/10 border-destructive/20",
  available: "text-available bg-available/10 border-available/20",
  neutral: "text-muted-foreground bg-muted border-border",
} as const;

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
  draft: { icon: PencilLine, label: he.status.draft, colorClass: TONE.neutral },
  submitted: { icon: Send, label: he.status.submitted, colorClass: TONE.neutral },
  proposed: {
    icon: MessageCircleQuestion,
    label: he.status.proposed,
    colorClass: TONE.amber,
  },
  assigned: { icon: CheckCircle2, label: he.status.assigned, colorClass: TONE.booked },
  merged: { icon: Users, label: he.status.merged, colorClass: TONE.booked },
  waitlisted: { icon: Clock, label: he.status.waitlisted, colorClass: TONE.amber },
  denied: { icon: XCircle, label: he.status.denied, colorClass: TONE.destructive },
  external: { icon: ExternalLink, label: he.status.external, colorClass: TONE.neutral },
  withdrawn: {
    icon: Ban,
    label: he.status.withdrawn,
    colorClass: TONE.neutral,
    strikethrough: true,
  },
  cancelled: {
    icon: Ban,
    label: he.status.cancelled,
    colorClass: TONE.destructive,
    strikethrough: true,
  },
};

const PROPOSAL_STATUS_META: Record<ProposalStatus, StatusMeta> = {
  draft: { icon: PencilLine, label: he.proposalStatus.draft, colorClass: TONE.neutral },
  sent: { icon: SendHorizontal, label: he.proposalStatus.sent, colorClass: TONE.amber },
  accepted: { icon: ThumbsUp, label: he.proposalStatus.accepted, colorClass: TONE.available },
  declined: { icon: ThumbsDown, label: he.proposalStatus.declined, colorClass: TONE.destructive },
  expired: { icon: TimerOff, label: he.proposalStatus.expired, colorClass: TONE.neutral },
  withdrawn: {
    icon: Ban,
    label: he.proposalStatus.withdrawn,
    colorClass: TONE.neutral,
    strikethrough: true,
  },
  applied: { icon: CheckCheck, label: he.proposalStatus.applied, colorClass: TONE.booked },
};

const RIDE_STATUS_META: Record<RideStatus, StatusMeta> = {
  draft: { icon: PencilLine, label: he.rideStatus.draft, colorClass: TONE.neutral },
  confirmed: {
    icon: CheckCircle2,
    label: he.rideStatus.confirmed,
    colorClass: TONE.booked,
  },
  flagged: { icon: XCircle, label: he.rideStatus.flagged, colorClass: TONE.amber },
  cancelled: {
    icon: Ban,
    label: he.rideStatus.cancelled,
    colorClass: TONE.destructive,
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
      className={cn("gap-1 font-medium transition-smooth", meta.colorClass, props.className)}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      <span className={cn(meta.strikethrough && "line-through")}>{meta.label}</span>
    </Badge>
  );
}

export { REQUEST_STATUS_META, PROPOSAL_STATUS_META, RIDE_STATUS_META };
