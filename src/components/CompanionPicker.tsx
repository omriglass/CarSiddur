import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { useContext, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { SheetPortalContext } from "@/components/SheetPortalContext";
import { t } from "@/i18n/he";
import { cn } from "@/lib/utils";

// Raw Radix primitives rather than the shared `components/ui/popover.tsx` (component inventory,
// same reasoning as `TimeField15`/`DestinationCombobox`): its `PopoverContent` always portals to
// `document.body` with no way to pass a `container`, so this field's own popover can't be moved
// into an ancestor `Sheet`'s content node (`SheetPortalContext`) for the nested-scroll/positioning
// fix those two fields needed — the quick-request sheet renders this component twice (companions,
// children).
const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;

export interface CompanionOption {
  id: string;
  name: string;
  isPriority?: boolean;
}

interface CompanionPickerProps {
  members: readonly CompanionOption[];
  value: readonly string[];
  onChange: (value: string[]) => void;
  label?: string;
}

/**
 * Department-members combobox with removable chips (component inventory
 * `CompanionPicker`, UX_FLOWS.md §3.4 "חברים שנוסעים איתך"). The caller
 * supplies the candidate list (already excludes the requester) and any
 * overlap warning — this component is presentational only, like
 * `DestinationCombobox`.
 */
export function CompanionPicker({ members, value, onChange, label = t("field.companions") }: CompanionPickerProps) {
  const [open, setOpen] = useState(false);
  const portalContainer = useContext(SheetPortalContext);
  const selected = members.filter((m) => value.includes(m.id));

  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {selected.map((m) => (
          <Badge key={m.id} variant="secondary" className="gap-1 py-1">
            {m.name}
            <button
              type="button"
              aria-label={`${m.name} ×`}
              onClick={() => toggle(m.id)}
              className="rounded-full hover:bg-muted-foreground/20"
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              role="combobox"
              aria-label={label}
              aria-expanded={open}
              className="h-8 gap-1"
            >
              {label}
              <ChevronsUpDown className="size-3.5 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverPrimitive.Portal container={portalContainer ?? undefined}>
            <PopoverPrimitive.Content
              align="start"
              sideOffset={4}
              className={cn(
                "z-50 w-64 rounded-md border bg-popover p-0 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
              )}
            >
              <Command>
                <CommandInput placeholder={label} />
                <CommandList>
                  <CommandEmpty>—</CommandEmpty>
                  <CommandGroup>
                    {members.map((m) => {
                      const isSelected = value.includes(m.id);
                      return (
                        <CommandItem key={m.id} value={m.name} onSelect={() => toggle(m.id)}>
                          <Check className={cn("size-4", isSelected ? "opacity-100" : "opacity-0")} />
                          {m.name}{m.isPriority ? " ★" : ""}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverPrimitive.Content>
          </PopoverPrimitive.Portal>
        </Popover>
      </div>
    </div>
  );
}
