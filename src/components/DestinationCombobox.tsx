import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Check, ChevronsUpDown, MapPin } from "lucide-react";
import { useContext, useState } from "react";

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
// same reasoning as `TimeField15`): its `PopoverContent` always portals to `document.body` with
// no way to pass a `container`, so this field's own popover can't be moved into an ancestor
// `Sheet`'s content node (`SheetPortalContext`) for the same nested-scroll fix `TimeField15` needed.
const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;

export interface DestinationPreset {
  id: string;
  name: string;
  aliases: readonly string[];
  zone?: string;
}

export type DestinationValue = { presetId: string; name: string } | { freeText: string };

/** Matches presets by name, alias or zone (UX_FLOWS.md §3.4 "DestinationCombobox searches presets by name and aliases"). */
export function filterDestinations(
  destinations: readonly DestinationPreset[],
  query: string,
): DestinationPreset[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...destinations];
  return destinations.filter((dest) => {
    const haystacks = [dest.name, dest.zone ?? "", ...dest.aliases];
    return haystacks.some((h) => h.toLowerCase().includes(normalized));
  });
}

interface DestinationComboboxProps {
  destinations: readonly DestinationPreset[];
  value: DestinationValue | null;
  mode?: "input" | "filter";
  onChange: (value: DestinationValue) => void;
  /** Opens the popover as soon as this component mounts (the quick-request sheet's required, focused field — UX_FLOWS.md §18). */
  autoFocus?: boolean;
  /** react-hook-form field name, for `useScrollToFirstError` to find this control on an invalid submit. */
  dataField?: string;
}

function labelFor(value: DestinationValue | null): string {
  if (!value) return "";
  return "presetId" in value ? value.name : value.freeText;
}

/**
 * Destination picker (component inventory `DestinationCombobox`): searches
 * presets by name/alias/zone, and always offers a free-text row as the last
 * option (UX_FLOWS.md §3.4) — typing something unknown never dead-ends.
 */
export function DestinationCombobox({ destinations, value, onChange, autoFocus, dataField }: DestinationComboboxProps) {
  const [open, setOpen] = useState(!!autoFocus);
  const [query, setQuery] = useState("");
  const matches = filterDestinations(destinations, query);
  const trimmedQuery = query.trim();
  const portalContainer = useContext(SheetPortalContext);

  function select(next: DestinationValue) {
    onChange(next);
    setOpen(false);
    setQuery("");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          data-field={dataField}
          className="h-11 w-full justify-between font-normal"
        >
          <span className="flex items-center gap-2 truncate">
            <MapPin className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            {labelFor(value) || t("field.destination")}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverPrimitive.Portal container={portalContainer ?? undefined}>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className={cn(
            "z-50 w-[--radix-popover-trigger-width] rounded-md border bg-popover p-0 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          )}
        >
          <Command shouldFilter={false}>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder={t("field.destination")}
            />
            <CommandList>
              <CommandEmpty>{t("field.destinationFreeText")}</CommandEmpty>
              <CommandGroup>
                {matches.map((dest) => {
                  const isSelected = value && "presetId" in value && value.presetId === dest.id;
                  return (
                    <CommandItem
                      key={dest.id}
                      value={dest.id}
                      onSelect={() => select({ presetId: dest.id, name: dest.name })}
                    >
                      <Check className={cn("size-4", isSelected ? "opacity-100" : "opacity-0")} />
                      {dest.name}
                      {dest.zone ? (
                        <span className="ms-1 text-xs text-muted-foreground">· {dest.zone}</span>
                      ) : null}
                    </CommandItem>
                  );
                })}
                {trimmedQuery ? (
                  <CommandItem value={`__freetext__${trimmedQuery}`} onSelect={() => select({ freeText: trimmedQuery })}>
                    <Check
                      className={cn(
                        "size-4",
                        value && "freeText" in value && value.freeText === trimmedQuery
                          ? "opacity-100"
                          : "opacity-0",
                      )}
                    />
                    &quot;{trimmedQuery}&quot; — {t("field.destinationFreeText")}
                  </CommandItem>
                ) : null}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </Popover>
  );
}
