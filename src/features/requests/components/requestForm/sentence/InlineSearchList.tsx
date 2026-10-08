// UX_FLOWS §3.4a: a search box plus a scrolling list rendered INLINE in a sheet (cmdk `Command`
// without a popover), so a place / member sheet never opens a second floating layer on top of
// itself. An optional free-text row comes last.
import { Check, Search } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";

export interface InlineSearchItem {
  key: string;
  label: string;
  /** Muted trailing detail (travel minutes). */
  hint?: ReactNode;
  selected?: boolean;
}

interface InlineSearchListProps {
  /** The rows for the current search text (the caller owns matching). */
  getItems: (query: string) => readonly InlineSearchItem[];
  onSelect: (key: string) => void;
  placeholder: string;
  /** Free-text row for the typed query; omitted = no such row. */
  freeText?: { label: (query: string) => string; onSelect: (query: string) => void };
  emptyText?: string;
  autoFocus?: boolean;
  className?: string;
}

export function InlineSearchList({ getItems, onSelect, placeholder, freeText, emptyText, autoFocus, className }: InlineSearchListProps) {
  const [query, setQuery] = useState("");
  const trimmed = query.trim();
  const items = getItems(trimmed);

  return (
    <Command shouldFilter={false} className={cn("overflow-visible rounded-md border bg-transparent", className)}>
      <div className="flex items-center gap-2 border-b px-3" cmdk-input-wrapper="">
        <Search className="size-4 shrink-0 opacity-50" aria-hidden="true" />
        <input
          autoFocus={autoFocus}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <CommandList className="max-h-[32dvh]">
        <CommandGroup className="p-1">
          {items.map((item) => (
            <CommandItem key={item.key} value={item.key} onSelect={() => { onSelect(item.key); setQuery(""); }} className="min-h-10 gap-2">
              <Check className={cn("size-4 shrink-0", item.selected ? "opacity-100" : "opacity-0")} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.hint ? <span className="shrink-0 text-xs text-muted-foreground">{item.hint}</span> : null}
            </CommandItem>
          ))}
          {items.length === 0 && !trimmed && emptyText ? <p className="py-3 text-center text-sm text-muted-foreground">{emptyText}</p> : null}
          {freeText && trimmed ? (
            <CommandItem value={`__free__${trimmed}`} onSelect={() => { freeText.onSelect(trimmed); setQuery(""); }} className="min-h-10 gap-2">
              <span className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{freeText.label(trimmed)}</span>
            </CommandItem>
          ) : null}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
