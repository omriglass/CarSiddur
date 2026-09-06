import { useState } from "react";
import { Info } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { he } from "@/i18n/he";

interface CarAtDestinationToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/** "הרכב נשאר איתי ביעד" switch with an expandable explanation (round trips only, UX_FLOWS §3.4). */
export function CarAtDestinationToggle({ checked, onChange }: CarAtDestinationToggleProps) {
  const [showHelp, setShowHelp] = useState(false);

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="car-at-destination" className="text-sm">
          {he.field.carAtDestination}
        </Label>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={he.field.carAtDestination}
            onClick={() => setShowHelp((v) => !v)}
          >
            <Info className="size-4 text-muted-foreground" />
          </Button>
          <Switch id="car-at-destination" checked={checked} onCheckedChange={onChange} />
        </div>
      </div>
      {showHelp ? (
        <p className="text-xs text-muted-foreground">{he.request.carAtDestinationHelper}</p>
      ) : null}
    </div>
  );
}
