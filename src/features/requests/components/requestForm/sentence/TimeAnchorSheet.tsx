// UX_FLOWS §3.4a "Time sheet": the anchor toggle (out: לצאת ב־ / להגיע עד, return: להיות בבית
// עד / לצאת משם ב־, a הקפצה pickup: איסוף משם ב־), the 15-minute time field, the derived
// estimate line and the flexibility row. Rendered inside a `FieldSheet`.
import { X } from "lucide-react";
import { useState } from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";

import { he, tv } from "@/i18n/he";
import type { TimeAnchor } from "@/lib/enums";

import { shiftReturnByDepartureDelta } from "../../../duration";
import type { RequestFormValues } from "../../../schema";
import {
  anchorLabelKey,
  endEstimate,
  enteredOutTime,
  enteredReturnTime,
  switchOutAnchor,
  switchReturnAnchor,
} from "../../../timeAnchors";
import { FieldError } from "../FieldError";
import { AnchorTimePicker } from "./AnchorTimePicker";
import { FlexibilityRow } from "./FlexibilityRow";
import { LtrText } from "./LtrText";
import { PillChip } from "./PillChip";

interface TimeAnchorSheetProps {
  form: UseFormReturn<RequestFormValues>;
  end: "out" | "return";
  /** A הקפצה's return leg is the pickup. */
  isPickup: boolean;
  /** `route_minutes_preview` of this leg; `null` while unknown. */
  routeMinutes: number | null;
  /** Anchor toggle + derived line. Off for quick/car-now and multi-day requests (leave/home-by only). */
  anchorsEnabled: boolean;
  /** The flexibility row of this end (weekly, single-day). */
  flexEnabled: boolean;
  /** "+ עצירה בחזור" under the return time (every variant but car-now). */
  stopsEnabled: boolean;
  /** Names of the return stops, in order (the sentence sheet adds/removes them — R9B4). */
  returnStops: readonly string[];
  onAddReturnStop?: () => void;
  onRemoveReturnStop?: (index: number) => void;
  timeError?: string;
  stopsError?: string;
}

export function TimeAnchorSheet({
  form,
  end,
  isPickup,
  routeMinutes,
  anchorsEnabled,
  flexEnabled,
  stopsEnabled,
  returnStops,
  onAddReturnStop,
  onRemoveReturnStop,
  timeError,
  stopsError,
}: TimeAnchorSheetProps) {
  const values = useWatch({ control: form.control });
  // R9U1: the return follows the departure; say so when it actually moved.
  const [movedReturn, setMovedReturn] = useState<string | null>(null);
  const departAnchor: TimeAnchor = values.departAnchor ?? "leave";
  const returnAnchor: TimeAnchor = values.returnAnchor ?? "arrive";
  const anchor = end === "out" ? departAnchor : returnAnchor;
  const entered = (end === "out"
    ? enteredOutTime({ departAnchor, arriveByTime: values.arriveByTime, departTime: values.departTime })
    : enteredReturnTime({ returnAnchor, leaveDestTime: values.leaveDestTime, returnTime: values.returnTime })) ?? (end === "out" ? "08:00" : "12:00");

  function setOutAnchor(next: TimeAnchor) {
    const patch = switchOutAnchor({ departAnchor, arriveByTime: values.arriveByTime, departTime: values.departTime }, next);
    form.setValue("departAnchor", patch.departAnchor, { shouldDirty: true });
    form.setValue("arriveByTime", patch.arriveByTime, { shouldDirty: true, shouldValidate: true });
    form.setValue("departTime", patch.departTime, { shouldDirty: true, shouldValidate: true });
  }

  function setReturnAnchor(next: TimeAnchor) {
    const patch = switchReturnAnchor({ returnAnchor, leaveDestTime: values.leaveDestTime, returnTime: values.returnTime }, next);
    form.setValue("returnAnchor", patch.returnAnchor, { shouldDirty: true });
    form.setValue("leaveDestTime", patch.leaveDestTime, { shouldDirty: true, shouldValidate: true });
    form.setValue("returnTime", patch.returnTime, { shouldDirty: true, shouldValidate: true });
  }

  function changeTime(next: string) {
    if (end === "out") {
      const previous = entered;
      form.setValue(departAnchor === "arrive" ? "arriveByTime" : "departTime", next, { shouldDirty: true, shouldValidate: true });
      // "Return follows departure": moving the *departure* moves the typed return by the same delta.
      // R11U11: only a typed departure counts — an "arrive by" time (and switching the anchor) never moves the return.
      if (departAnchor === "arrive") {
        setMovedReturn(null);
        return;
      }
      const currentReturn = enteredReturnTime({ returnAnchor, leaveDestTime: form.getValues("leaveDestTime"), returnTime: form.getValues("returnTime") });
      const shifted = shiftReturnByDepartureDelta(previous, next, currentReturn);
      if (shifted !== currentReturn) {
        form.setValue(returnAnchor === "leave" ? "leaveDestTime" : "returnTime", shifted, { shouldDirty: true, shouldValidate: true });
      }
      setMovedReturn(shifted && shifted !== currentReturn ? shifted : null);
      return;
    }
    form.setValue(returnAnchor === "leave" ? "leaveDestTime" : "returnTime", next, { shouldDirty: true, shouldValidate: true });
  }

  const options: TimeAnchor[] = end === "out" ? ["leave", "arrive"] : ["arrive", "leave"];
  const estimate = anchorsEnabled && routeMinutes != null ? endEstimate(end, anchor, entered, routeMinutes) : null;
  const ariaLabel = end === "out" ? he.field.depart : he.field.return;

  return (
    <div className="space-y-3" data-testid={`time-sheet-${end}`}>
      <AnchorTimePicker
        anchors={anchorsEnabled ? options : null}
        anchor={anchor}
        anchorLabel={(option) => he.requestSentence.anchor[anchorLabelKey(end, option, isPickup)]}
        onAnchorChange={(next) => {
          if (end === "out") setOutAnchor(next);
          else setReturnAnchor(next);
        }}
        value={entered}
        onChange={changeTime}
        min="06:00"
        max={end === "return" ? "23:59" : undefined}
        ariaLabel={ariaLabel}
        dataField={end === "out" ? "departTime" : "returnTime"}
        error={timeError}
        estimate={estimate}
        estimateTestId={`time-estimate-${end}`}
        beforeEstimate={end === "out" && movedReturn ? (
          <p className="text-center text-sm text-muted-foreground" data-testid="return-moved-note">
            <LtrText text={tv("requestSentence.returnMoved", { time: movedReturn })} />
          </p>
        ) : null}
      />

      {flexEnabled ? (
        end === "out" ? (
          <FlexibilityRow
            early={values.flexDepartEarly ?? 0}
            late={values.flexDepartLate ?? 0}
            dataField="flexDepartEarly"
            onChange={(early, late) => {
              form.setValue("flexDepartEarly", early, { shouldDirty: true });
              form.setValue("flexDepartLate", late, { shouldDirty: true });
            }}
          />
        ) : (
          <FlexibilityRow
            early={values.flexReturnEarly ?? 0}
            late={values.flexReturnLate ?? 0}
            dataField="flexReturnEarly"
            onChange={(early, late) => {
              form.setValue("flexReturnEarly", early, { shouldDirty: true });
              form.setValue("flexReturnLate", late, { shouldDirty: true });
            }}
          />
        )
      ) : null}

      {end === "return" && stopsEnabled ? (
        <div className="space-y-1.5" data-field="returnStops">
          <div className="flex flex-wrap gap-1.5">
            {returnStops.map((name, index) => (
              <PillChip key={`${index}:${name}`} pressed aria-label={`${he.request.removeStop}: ${name}`} onClick={() => onRemoveReturnStop?.(index)} data-testid="return-stop-pill">
                {name}
                <X className="size-3" aria-hidden="true" />
              </PillChip>
            ))}
            {onAddReturnStop ? (
              <PillChip dashed onClick={onAddReturnStop} data-testid="add-return-stop">{he.request.addReturnStop}</PillChip>
            ) : null}
          </div>
          <FieldError message={stopsError} />
        </div>
      ) : null}
    </div>
  );
}
