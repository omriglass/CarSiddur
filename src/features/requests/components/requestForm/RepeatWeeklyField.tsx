// Extracted from `RequestForm.tsx` (docs/TODO.md "Code review 2026-09-24" R9):
// the "repeat weekly" switch (UX_FLOWS §3.3/§3.4, REQ §76). Pure move —
// behaviour and markup unchanged.
import { Controller, type Control } from "react-hook-form";

import { FormItem } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n/he";

import type { RequestFormValues } from "../../schema";

export interface RepeatWeeklyFieldProps {
  control: Control<RequestFormValues>;
}

export function RepeatWeeklyField({ control }: RepeatWeeklyFieldProps) {
  return (
    <Controller
      control={control}
      name="repeatWeekly"
      render={({ field }) => (
        <FormItem className="flex items-center justify-between gap-3 rounded-md border p-3" data-field="repeatWeekly">
          <div className="space-y-0.5">
            <Label htmlFor="request-repeat-weekly">{t("request.repeatWeekly")}</Label>
            <p className="text-xs text-muted-foreground">{t("request.repeatWeeklyHint")}</p>
          </div>
          <Switch id="request-repeat-weekly" checked={field.value} onCheckedChange={field.onChange} />
        </FormItem>
      )}
    />
  );
}
