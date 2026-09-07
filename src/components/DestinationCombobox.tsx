import { Check, ChevronsUpDown, MapPin } from "lucide-react";
import { useState } from "react";

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
export function DestinationCombobox({ destinations, value, onChange, autoFocus }: DestinationComboboxProps) {
  const [open, setOpen] = useState(!!autoFocus);
  const [query, setQuery] = useState("");
  const matches = filterDestinations(destinations, query);
  const trimmedQuery = query.trim();

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
          className="h-11 w-full justify-between font-normal"
        >
          <span className="flex items-center gap-2 truncate">
            <MapPin className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            {labelFor(value) || t("field.destination")}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
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
      </PopoverContent>
    </Popover>
  );
}
