import { useState } from "react";

import { FormDialog } from "@/components/FormDialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { he, tv } from "@/i18n/he";

/** What to do with a passenger x who rides on y's request in a merged ride (owner 2026-11-09). */
export type MergedPassengerChoice = "removeOnly" | "withOwner" | "alone";

export interface MergedPassengerTarget {
  requestId: string;
  profileId: string;
  name: string;
  /** y: the requester x rides with. */
  owner: string;
  /** y's request was merged in (not the host's own): "split x and y" applies. */
  ownerIsGuest: boolean;
}

interface MergedPassengerDialogProps {
  target: MergedPassengerTarget | null;
  /** z: whose ride it is. */
  host: string;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (choice: MergedPassengerChoice, target: MergedPassengerTarget) => void;
}

/**
 * Taking a passenger out of a merged ride asks how (owner 2026-11-09): only x leaves; x and y leave together
 * (y's request was merged in); or x alone gets a request of their own with y's details (`split_ride_companion`).
 */
export function MergedPassengerDialog({ target, host, busy, onOpenChange, onChoose }: MergedPassengerDialogProps) {
  const [choice, setChoice] = useState<MergedPassengerChoice>("removeOnly");
  const [seen, setSeen] = useState<string | null>(null);
  const key = target ? `${target.requestId}:${target.profileId}` : null;
  if (key !== seen) {
    setSeen(key);
    setChoice("removeOnly");
  }
  if (!target) return null;
  const vars = { name: target.name, owner: target.owner, host };
  const options: { id: MergedPassengerChoice; label: string; help: string }[] = [
    { id: "removeOnly", label: tv("mergedRide.splitRemoveOnly", vars), help: tv("mergedRide.splitRemoveOnlyHelp", vars) },
    ...(target.ownerIsGuest ? [{ id: "withOwner" as const, label: tv("mergedRide.splitWithOwner", vars), help: tv("mergedRide.splitWithOwnerHelp", vars) }] : []),
    { id: "alone", label: tv("mergedRide.splitAlone", vars), help: tv("mergedRide.splitAloneHelp", vars) },
  ];
  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title={tv("mergedRide.splitTitle", vars)}
      submitLabel={he.mergedRide.splitConfirm}
      loading={busy}
      onSubmit={() => onChoose(choice, target)}
    >
      <RadioGroup value={choice} onValueChange={(value) => setChoice(value as MergedPassengerChoice)} className="space-y-3" data-testid="merged-passenger-options">
        {options.map((option) => (
          <div key={option.id} className="flex items-start gap-2">
            <RadioGroupItem value={option.id} id={`merged-passenger-${option.id}`} className="mt-1" data-testid={`merged-passenger-${option.id}`} />
            <Label htmlFor={`merged-passenger-${option.id}`} className="min-w-0 flex-1 space-y-1 break-words font-normal leading-snug">
              <span className="block font-medium">{option.label}</span>
              <span className="block text-xs text-muted-foreground">{option.help}</span>
            </Label>
          </div>
        ))}
      </RadioGroup>
    </FormDialog>
  );
}
