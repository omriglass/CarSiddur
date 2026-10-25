import { cn } from "@/lib/utils";

/**
 * R13F3: a quiet "n/max" under a text field — shown only once the text nears the limit (80 %), so short notes
 * never see it. The field's own `maxLength` still stops typing at `max`.
 */
export function CharCount({ value, max, className }: { value: string | null | undefined; max: number; className?: string }) {
  const length = value?.length ?? 0;
  if (length < max * 0.8) return null;
  return (
    <p dir="ltr" className={cn("text-end text-[11px] tabular-nums", length >= max ? "text-destructive" : "text-muted-foreground", className)} aria-live="polite">
      {length}/{max}
    </p>
  );
}
