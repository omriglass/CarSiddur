// Owner 2026-10-16 (UX_FLOWS §4.2): the unplaced-request card's "⋮" menu. Every secondary action lives here;
// the dialogs of the existing actions open in controlled mode (no inline buttons any more).
import { useState } from "react";
import { MoreVertical } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { useRequestLinkProps } from "@/app/overlayState";
import { paths } from "@/app/routes";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { buildWaUrl } from "../../proposals/waLink";
import { useProfilesByIds } from "../../hooks";

import { FewerDaysAction, type FewerDaysSupport } from "./FewerDaysAction";
import { canSwitchPlan as canSwitchRequestPlan } from "../planSwitch";
import { PlanSwitchButton } from "./PlanSwitchButton";
import { TripTypeChange } from "./TripTypeChange";
import { WithdrawDuplicateAction } from "./WithdrawDuplicateAction";
import { CloseRequestAction } from "./CloseRequestAction";

import type { WeekRequestRow } from "../../api";

type Dialogs = "tripType" | "plan" | "duplicate" | "fewerDays" | "close" | null;

export interface UnmetCardMenuProps {
  request: WeekRequestRow;
  destinationName: string;
  /** A proposal is already out: only editing/WhatsApp stay (the other actions would race it). */
  proposalOut: boolean;
  tripTypeScope?: { departmentId: string; weekStart: string };
  fewerDays?: FewerDaysSupport;
  /** Hidden when the member said "אסתדר" (REQ §13.112 b) or no decision handler exists. */
  onExternal?: () => void;
  onDeny?: () => void;
  /** "הצעת שעות אחרות" (owner 2026-10-16: in the menu, not on the card). */
  onShift?: () => void;
  /** R14M1: "שבץ ברכב…" - opens the car picker (the phone has no usable drag). */
  onPlaceOnCar?: () => void;
}

/** Mounted only while the menu is open, so the phone number is fetched on demand (never for every card). */
function WhatsappItem({ request, destinationName }: { request: WeekRequestRow; destinationName: string }) {
  const phoneQuery = useProfilesByIds([request.requester_id]);
  const phone = phoneQuery.data?.[0]?.phone;
  const name = request.requester_full_name ?? "";
  const day = request.depart_at ?? request.return_at;
  if (!phone) return null;
  const href = buildWaUrl(phone, tv("unmetCard.whatsappGreeting", { name, destination: destinationName, day: day ? formatDayDate(day) : "" }));
  return (
    <DropdownMenuItem asChild className="min-h-11">
      <a href={href} target="_blank" rel="noreferrer" data-testid="unmet-whatsapp">{he.unmetCard.whatsapp}</a>
    </DropdownMenuItem>
  );
}

export function UnmetCardMenu({ request, destinationName, proposalOut, tripTypeScope, fewerDays, onExternal, onDeny, onShift, onPlaceOnCar }: UnmetCardMenuProps) {
  const navigate = useNavigate();
  const link = useRequestLinkProps();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const name = request.requester_full_name ?? "";
  const open = (next: Dialogs) => () => { setMenuOpen(false); setDialog(next); };
  const closer = (kind: Exclude<Dialogs, null>) => (isOpen: boolean) => { if (!isOpen) setDialog((current) => (current === kind ? null : current)); };
  const scoped = !!tripTypeScope && !proposalOut;
  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon" className="size-11 shrink-0" aria-label={tv("unmetCard.menuAria", { name })} data-testid="unmet-menu">
            <MoreVertical className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem className="min-h-11" data-testid="unmet-edit" onSelect={() => navigate(paths.requests.edit(request.id), { state: link.state })}>
            {he.unmetCard.editRequest}
          </DropdownMenuItem>
          {onPlaceOnCar && !proposalOut ? <DropdownMenuItem className="min-h-11" data-testid="unmet-place-on-car" onSelect={onPlaceOnCar}>{he.unmetCard.placeOnCar}</DropdownMenuItem> : null}
          {scoped ? <DropdownMenuItem className="min-h-11" data-testid="unmet-change-trip-type" onSelect={open("tripType")}>{he.unmetCard.changeTripType}</DropdownMenuItem> : null}
          {scoped && canSwitchRequestPlan(request) ? <DropdownMenuItem className="min-h-11" data-testid="unmet-plan-switch" onSelect={open("plan")}>{request.served_by_alternative ? he.planSwitch.toMain : he.planSwitch.toAlternative}</DropdownMenuItem> : null}
          {onShift && !proposalOut ? <DropdownMenuItem className="min-h-11" data-testid="unmet-shift" onSelect={onShift}>{he.sadranProposal.suggestTimes}</DropdownMenuItem> : null}
          {onExternal && !proposalOut ? <DropdownMenuItem className="min-h-11" data-testid="unmet-external" onSelect={onExternal}>{he.unmetCard.proposeExternal}</DropdownMenuItem> : null}
          {onDeny && !proposalOut ? <DropdownMenuItem className="min-h-11" data-testid="unmet-deny" onSelect={onDeny}>{he.unmetCard.proposeDeny}</DropdownMenuItem> : null}
          {scoped && !request.series_id ? <DropdownMenuItem className="min-h-11" data-testid="unmet-duplicate" onSelect={open("duplicate")}>{he.unmetCard.markDuplicate}</DropdownMenuItem> : null}
          {fewerDays && !proposalOut && request.series_id ? <DropdownMenuItem className="min-h-11" data-testid="unmet-fewer-days" onSelect={open("fewerDays")}>{he.fewerDays.action}</DropdownMenuItem> : null}
          {/* REQ §13.162 (b): close a request that is no longer needed (proposals out are withdrawn with it). */}
          {tripTypeScope ? <DropdownMenuItem className="min-h-11 text-destructive" data-testid="unmet-close-request" onSelect={open("close")}>{he.closeRequest.menuItem}</DropdownMenuItem> : null}
          <DropdownMenuSeparator />
          {menuOpen ? <WhatsappItem request={request} destinationName={destinationName} /> : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {tripTypeScope ? (
        <TripTypeChange requestId={request.id} version={request.version} tripType={request.trip_type} keepCarAtDestination={request.keep_car_at_destination}
          destination={destinationName} name={name} departmentId={tripTypeScope.departmentId} weekStart={tripTypeScope.weekStart} wasUnplaced
          open={dialog === "tripType"} onOpenChange={closer("tripType")} />
      ) : null}
      {tripTypeScope && dialog === "plan" ? (
        <PlanSwitchButton request={request} name={name} departmentId={tripTypeScope.departmentId} weekStart={tripTypeScope.weekStart} open onOpenChange={closer("plan")} />
      ) : null}
      {tripTypeScope && dialog === "duplicate" ? (
        <WithdrawDuplicateAction requestId={request.id} version={request.version} name={name} departmentId={tripTypeScope.departmentId} weekStart={tripTypeScope.weekStart} open onOpenChange={closer("duplicate")} />
      ) : null}
      {tripTypeScope && dialog === "close" ? (
        <CloseRequestAction requestId={request.id} version={request.version} name={name} departmentId={tripTypeScope.departmentId} weekStart={tripTypeScope.weekStart}
          series={!!request.series_id} open onOpenChange={closer("close")} />
      ) : null}
      {fewerDays && dialog === "fewerDays" ? <FewerDaysAction request={request} support={fewerDays} open onOpenChange={closer("fewerDays")} /> : null}
    </>
  );
}
