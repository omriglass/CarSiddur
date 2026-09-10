import { useState } from "react";
import { Check } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { he, tv } from "@/i18n/he";
import { TZ } from "@/lib/time";
import { formatInTimeZone } from "date-fns-tz";

import type { ActivePolicy, PolicyOption } from "../../api";

interface PolicyChipProps {
  policyOptions: PolicyOption[];
  activePolicy: ActivePolicy | null;
  value: string | null;
  stale: boolean;
  onSelect: (policyVersionId: string) => void;
}

/**
 * Policy chip + versions dialog (UX_FLOWS.md §4.2), replacing the plain
 * policy `<Select>`: the chip shows "{{name}} · גרסה {{version}}"; tapping it
 * opens a dialog listing every one of the department's policies (each row is
 * that policy's *current* version — `usePolicyOptions` already scopes to
 * one row per policy) with its version number, creation date (Asia/Jerusalem)
 * and note, a check mark on the currently-selected one. Selecting a row
 * calls `onSelect` and closes; the amber "policy changed" badge stays next
 * to the chip exactly as it sat next to the old `<Select>`.
 */
export function PolicyChip({ policyOptions, activePolicy, value, stale, onSelect }: PolicyChipProps) {
  const [open, setOpen] = useState(false);
  const current = policyOptions.find((option) => option.policyVersionId === value);
  const label = current
    ? tv("sadranBoard.policyChip", { name: current.name, version: String(current.versionNo) })
    : activePolicy
      ? tv("sadranBoard.policyChip", { name: activePolicy.name, version: String(activePolicy.versionNo) })
      : he.board.policy;

  return <>
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="gap-1"
      onClick={() => setOpen(true)}
      data-testid="board-policy-chip"
    >
      {label}
    </Button>
    {stale ? (
      <Badge variant="outline" className="border-amber-500 text-amber-600">
        {he.board.policyChanged}
      </Badge>
    ) : null}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>{he.sadranBoard.policyDialogTitle}</DialogTitle></DialogHeader>
        <ul className="max-h-[60dvh] space-y-2 overflow-y-auto">
          {policyOptions.map((option) => (
            <li key={option.policyVersionId}>
              <button
                type="button"
                data-testid={`board-policy-option-${option.policyVersionId}`}
                className="w-full rounded-md border p-3 text-start hover:bg-accent/40"
                onClick={() => { onSelect(option.policyVersionId); setOpen(false); }}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium">{option.name} · {tv("sadranPublish.versionLabel", { n: String(option.versionNo) })}</span>
                  {option.policyVersionId === value ? <Check className="size-4 shrink-0 text-primary" aria-hidden="true" /> : null}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground" dir="ltr">
                  {formatInTimeZone(option.createdAt, TZ, "d/M/yyyy")}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {option.note || he.sadranBoard.policyVersionNote}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  </>;
}
