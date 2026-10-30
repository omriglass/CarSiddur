import { Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { he } from "@/i18n/he";
import { cn } from "@/lib/utils";

/** The pencil next to the spyglass and the eye (owner 2026-10-30): edit mode on = rides drag at once; it has a coloured background while on. */
export function EditModeButton({ on, onChange }: { on: boolean; onChange: (next: boolean) => void }) {
  return (
    <Button
      type="button"
      variant={on ? "default" : "outline"}
      size="icon"
      aria-pressed={on}
      aria-label={on ? he.editMode.turnOff : he.editMode.turnOn}
      title={on ? he.editMode.turnOff : he.editMode.turnOn}
      onClick={() => onChange(!on)}
      className={cn(on && "ring-2 ring-primary/40")}
      data-testid="edit-mode-button"
      data-on={on || undefined}
    >
      <Pencil className="size-4" />
    </Button>
  );
}
