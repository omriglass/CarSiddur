import {
  AlertTriangle,
  Archive,
  Ban,
  CheckCheck,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  Inbox,
  MessageCircleQuestion,
  PencilLine,
  Send,
  SendHorizontal,
  ThumbsDown,
  ThumbsUp,
  TimerOff,
  UserPlus,
  Users,
  Wrench,
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
type CarStatus = Database["public"]["Enums"]["car_status"];
type WeekPhase = Database["public"]["Enums"]["week_phase"];
/**
 * Mirrors `ParsedInviteRowStatus`
 * (`src/features/admin/members/lib/parseInviteLines.ts`) — a plain TS union,
 * not a DB enum, so re-declared locally rather than importing a
 * feature-local type into a shared component (components must not depend
 * on features).
 */
type InviteRowStatus = "new" | "existing" | "invalid_email" | "duplicate";

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

const CAR_STATUS_META: Record<CarStatus, StatusMeta> = {
  active: { icon: CheckCircle2, label: he.car.status.active, colorClass: TONE.available },
  maintenance: { icon: Wrench, label: he.car.status.maintenance, colorClass: TONE.amber },
  retired: {
    icon: Ban,
    label: he.car.status.retired,
    colorClass: TONE.neutral,
    strikethrough: true,
  },
};

/**
 * `weeks.phase` (`he.phase`, DATA_MODEL §2 / consistency decision #4). Used
 * by the desktop week strip and the siddur archive list (`SiddurArchivePage`)
 * — previously the week chip rendered `he.phase[w.phase]` as plain text.
 */
const WEEK_PHASE_META: Record<WeekPhase, StatusMeta> = {
  open: { icon: Inbox, label: he.phase.open, colorClass: TONE.neutral },
  solving: { icon: Wrench, label: he.phase.solving, colorClass: TONE.amber },
  published: { icon: CheckCircle2, label: he.phase.published, colorClass: TONE.booked },
  live: { icon: SendHorizontal, label: he.phase.live, colorClass: TONE.available },
  archived: { icon: Archive, label: he.phase.archived, colorClass: TONE.neutral },
};

const INVITE_ROW_STATUS_META: Record<InviteRowStatus, StatusMeta> = {
  new: { icon: UserPlus, label: he.adminMembers.importRowNew, colorClass: TONE.available },
  existing: { icon: Users, label: he.adminMembers.importRowExisting, colorClass: TONE.neutral },
  invalid_email: {
    icon: AlertTriangle,
    label: he.adminMembers.importRowInvalidEmail,
    colorClass: TONE.destructive,
  },
  duplicate: { icon: Copy, label: he.adminMembers.importRowDuplicate, colorClass: TONE.destructive },
};

type StatusBadgeProps =
  | { kind: "request"; status: RequestStatus; className?: string }
  | { kind: "proposal"; status: ProposalStatus; className?: string }
  | { kind: "ride"; status: RideStatus; className?: string }
  | { kind: "car"; status: CarStatus; className?: string }
  | { kind: "week"; status: WeekPhase; className?: string }
  | { kind: "inviteRow"; status: InviteRowStatus; className?: string };

/**
 * Color + icon + Hebrew text, never color alone (UX_FLOWS.md §7.3/§7.4).
 * `kind` picks which status domain `status` belongs to: `request`/`ride`/
 * `proposal`/`car`/`week` (DB enums; `week` = `weeks.phase`) or `inviteRow`
 * (the bulk member-invite preview's plain-TS-union row status, admin
 * members screen).
 */
function metaFor(props: StatusBadgeProps): StatusMeta {
  switch (props.kind) {
    case "request":
      return REQUEST_STATUS_META[props.status];
    case "proposal":
      return PROPOSAL_STATUS_META[props.status];
    case "ride":
      return RIDE_STATUS_META[props.status];
    case "car":
      return CAR_STATUS_META[props.status];
    case "week":
      return WEEK_PHASE_META[props.status];
    case "inviteRow":
      return INVITE_ROW_STATUS_META[props.status];
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

export { REQUEST_STATUS_META, PROPOSAL_STATUS_META, RIDE_STATUS_META, CAR_STATUS_META, WEEK_PHASE_META, INVITE_ROW_STATUS_META };
