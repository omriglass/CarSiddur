// Extracted from `RequestForm.tsx` (docs/TODO.md "Code review 2026-09-24" R9):
// the "repeat weekly" switch (UX_FLOWS §3.3/§3.4, REQ §76). REQ §13.159: once on,
// one quiet "כל שבוע · שינוי" line; "שינוי" opens a 1–8 week selector.
import { useState } from "react";
import { Controller, useWatch, type Control } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { FormItem } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { t, tv } from "@/i18n/he";

import { REPEAT_EVERY_WEEKS, repeatEveryLabel, repeatWeeksLabel } from "../../repeatEvery";
import type { RequestFormValues } from "../../schema";

export interface RepeatWeeklyFieldProps {
  control: Control<RequestFormValues>;
}

export function RepeatWeeklyField({ control }: RepeatWeeklyFieldProps) {
  const on = useWatch({ control, name: "repeatWeekly" });
  const everyWeeks = useWatch({ control, name: "repeatEveryWeeks" }) ?? 1;
  const [choosing, setChoosing] = useState(false);

  return (
    <FormItem className="flex flex-col gap-2 rounded-md border p-3" data-field="repeatWeekly">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <Label htmlFor="request-repeat-weekly">{on ? t("request.repeatTitle") : t("request.repeatWeekly")}</Label>
          {on && !choosing ? (
            <p className="text-sm" data-testid="repeat-every">
              {repeatEveryLabel(everyWeeks)} ·{" "}
              <Button type="button" variant="link" size="sm" className="h-auto px-0 text-sm" onClick={() => setChoosing(true)}>
                {t("request.repeatChange")}
              </Button>
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {on && everyWeeks > 1 ? tv("request.repeatEveryHint", { every: repeatEveryLabel(everyWeeks) }) : t("request.repeatWeeklyHint")}
          </p>
        </div>
        <Controller
          control={control}
          name="repeatWeekly"
          render={({ field }) => <Switch id="request-repeat-weekly" checked={field.value} onCheckedChange={field.onChange} />}
        />
      </div>
      {on && choosing ? (
        <Controller
          control={control}
          name="repeatEveryWeeks"
          render={({ field }) => (
            <label className="flex items-center gap-2 text-sm" data-field="repeatEveryWeeks">
              {t("request.repeatEveryPrefix")}
              <select
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={everyWeeks}
                data-testid="repeat-every-select"
                onChange={(event) => {
                  field.onChange(Number(event.target.value));
                  setChoosing(false);
                }}
              >
                {REPEAT_EVERY_WEEKS.map((weeks) => (
                  <option key={weeks} value={weeks}>
                    {repeatWeeksLabel(weeks)}
                  </option>
                ))}
              </select>
            </label>
          )}
        />
      ) : null}
    </FormItem>
  );
}
