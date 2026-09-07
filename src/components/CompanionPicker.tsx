import { Check, ChevronsUpDown, X } from "lucide-react";
import { useState } from "react";

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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n/he";
import { cn } from "@/lib/utils";

export interface CompanionOption {
  id: string;
  name: string;
}

interface CompanionPickerProps {
  members: readonly CompanionOption[];
  value: readonly string[];
  onChange: (value: string[]) => void;
}

/**
 * Department-members combobox with removable chips (component inventory
 * `CompanionPicker`, UX_FLOWS.md §3.4 "חברים שנוסעים איתך"). The caller
 * supplies the candidate list (already excludes the requester) and any
 * overlap warning — this component is presentational only, like
 * `DestinationCombobox`.
 */
export function CompanionPicker({ members, value, onChange }: CompanionPickerProps) {
  const [open, setOpen] = useState(false);
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
              aria-label={t("field.companions")}
              aria-expanded={open}
              className="h-8 gap-1"
            >
              {t("field.companions")}
              <ChevronsUpDown className="size-3.5 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-0" align="start">
            <Command>
              <CommandInput placeholder={t("field.companions")} />
              <CommandList>
                <CommandEmpty>—</CommandEmpty>
                <CommandGroup>
                  {members.map((m) => {
                    const isSelected = value.includes(m.id);
                    return (
                      <CommandItem key={m.id} value={m.name} onSelect={() => toggle(m.id)}>
                        <Check className={cn("size-4", isSelected ? "opacity-100" : "opacity-0")} />
                        {m.name}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
