// UX_FLOWS §3.4b: the draft card — one line per detail, "? חסר" for a missing one, the last turn's change highlighted,
// an edit's old value struck through.
import { he } from "@/i18n/he";
import { cn } from "@/lib/utils";

import type { DraftCard } from "../draftCard";

export function AskDraftCardView({ card, updated }: { card: DraftCard; updated: boolean }) {
  return (
    <div className="rounded-lg border bg-card p-3" data-testid="ask-draft-card">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-semibold">{card.kind === "edit" ? he.ask.editTitle : he.ask.newTitle}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{updated ? he.ask.tagUpdated : he.ask.tagDraft}</span>
      </div>
      <dl className="space-y-1 text-sm">
        {card.rows.map((row) => (
          <div key={row.key} className="flex gap-2" data-testid={`ask-row-${row.key}`}>
            <dt className="w-16 shrink-0 text-muted-foreground">{row.label}</dt>
            <dd className={cn("min-w-0", row.value === null && "font-medium text-amber-700 dark:text-amber-400",
              row.changed && "rounded bg-emerald-100 px-1 dark:bg-emerald-900/40")}>
              {row.old !== undefined ? <><span className="text-muted-foreground line-through">{row.old}</span>{" ← "}</> : null}
              {row.value ?? he.ask.missing}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
