// UX_FLOWS §3.4a "Time sheet": the anchor toggle (out: לצאת ב־ / להגיע עד, return: להיות בבית
// עד / לצאת משם ב־, a הקפצה pickup: איסוף משם ב־), the 15-minute time field, the derived
// estimate line and the flexibility row. Rendered inside a `FieldSheet`.
import { X } from "lucide-react";
import { useState } from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";

import { TimeField15 } from "@/components/TimeField15";
import { he, tv } from "@/i18n/he";
import type { TimeAnchor } from "@/lib/enums";

import { returnFollowsDeparture, shiftReturnByDepartureDelta, timeToMinutes } from "../../../duration";
import { driveMinutesFrom, type RushWindows } from "../../../rushHours";
import type { RequestFormValues } from "../../../schema";
import {
  anchorLabelKey,
  bothOutHours,
  bothReturnHours,
  ceilToQuarter,
  clampedTime,
  endEstimate,
  enteredOutTime,
  enteredReturnTime,
  floorToQuarter,
  switchOutAnchor,
  switchReturnAnchor,
} from "../../../timeAnchors";
import { AnchorTimePicker } from "./AnchorTimePicker";
import { FlexibilityRow } from "./FlexibilityRow";
import { LtrText } from "./LtrText";

interface TimeAnchorSheetProps {
  form: UseFormReturn<RequestFormValues>;
  end: "out" | "return";
  /** A הקפצה's return leg is the pickup. */
  isPickup: boolean;
  /** `route_minutes_preview` of this leg; `null` while unknown. */
  routeMinutes: number | null;
  /** The request day's rush-hour windows (REQ §13.113). */
  rush: RushWindows;
  /** Anchor toggle + derived line. Off for quick/car-now and multi-day requests (leave/home-by only). */
  anchorsEnabled: boolean;
  /** The flexibility row of this end (weekly, single-day). */
  flexEnabled: boolean;
  timeError?: string;
}

export function TimeAnchorSheet({
  form,
  end,
  isPickup,
  routeMinutes,
  rush,
  anchorsEnabled,
  flexEnabled,
  timeError,
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
    // Both hours given: the toggle keeps "להגיע עד" and drops the departure (it is worked out again).
    if (next === "arrive" && bothOutHours({ departAnchor, arriveByTime: values.arriveByTime })) {
      form.setValue("departAnchor", "arrive", { shouldDirty: true });
      return;
    }
    const patch = switchOutAnchor({ departAnchor, arriveByTime: values.arriveByTime, departTime: values.departTime }, next);
    form.setValue("departAnchor", patch.departAnchor, { shouldDirty: true });
    form.setValue("arriveByTime", patch.arriveByTime, { shouldDirty: true, shouldValidate: true });
    form.setValue("departTime", patch.departTime, { shouldDirty: true, shouldValidate: true });
  }

  function setReturnAnchor(next: TimeAnchor) {
    if (next === "leave" && bothReturnHours({ returnAnchor, leaveDestTime: values.leaveDestTime })) {
      form.setValue("returnAnchor", "leave", { shouldDirty: true });
      return;
    }
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
      if (departAnchor === "arrive" || !returnFollowsDeparture({ day: form.getValues("day"), returnDay: form.getValues("returnDay") })) {
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
  // REQ item 249 (a): the way's second hour - "להגיע עד" beside "לצאת ב־", "לצאת משם ב־" beside "בבית עד".
  const secondEnabled = anchorsEnabled && !isPickup;
  const both = end === "out"
    ? bothOutHours({ departAnchor, arriveByTime: values.arriveByTime })
    : bothReturnHours({ returnAnchor, leaveDestTime: values.leaveDestTime });
  const second = end === "out" ? values.arriveByTime : values.leaveDestTime;
  const estimate = anchorsEnabled && routeMinutes != null && !both ? endEstimate(end, anchor, entered, routeMinutes, rush) : null;
  // The drive between the two hours: the member's minutes and the app's estimate (margin + rush hours).
  const bothLine = both && second && routeMinutes != null ? (() => {
    const from = end === "out" ? entered : second;
    const to = end === "out" ? second : entered;
    const given = timeToMinutes(to) - timeToMinutes(from);
    const estimated = driveMinutesFrom(timeToMinutes(from), routeMinutes, rush);
    return { text: tv("requestSentence.secondHour.drive", { given: String(given), estimate: String(estimated) }), tight: given < estimated };
  })() : null;

  function addSecond() {
    if (end === "out") {
      if (departAnchor === "arrive") { form.setValue("departAnchor", "leave", { shouldDirty: true }); return; }
      const leave = timeToMinutes(entered);
      const drive = routeMinutes != null ? driveMinutesFrom(leave, routeMinutes, rush) : 60;
      form.setValue("arriveByTime", clampedTime(ceilToQuarter(leave + drive)), { shouldDirty: true, shouldValidate: true });
      return;
    }
    if (returnAnchor === "leave") { form.setValue("returnAnchor", "arrive", { shouldDirty: true }); return; }
    const home = timeToMinutes(entered);
    const drive = routeMinutes ?? 60;
    form.setValue("leaveDestTime", clampedTime(floorToQuarter(home - drive)), { shouldDirty: true, shouldValidate: true });
  }

  function removeSecond() {
    form.setValue(end === "out" ? "arriveByTime" : "leaveDestTime", undefined, { shouldDirty: true, shouldValidate: true });
  }

  function changeSecond(next: string) {
    form.setValue(end === "out" ? "arriveByTime" : "leaveDestTime", next, { shouldDirty: true, shouldValidate: true });
  }

  const addLabel = end === "out"
    ? (departAnchor === "arrive" ? he.requestSentence.secondHour.outAddLeave : he.requestSentence.secondHour.outAddArrive)
    : (returnAnchor === "leave" ? he.requestSentence.secondHour.returnAddArrive : he.requestSentence.secondHour.returnAddLeave);
  const secondLabel = he.requestSentence.anchor[end === "out" ? "outArrive" : "returnLeave"];
  // Never on the wrong side of the first hour.
  const enteredMinutes = timeToMinutes(entered);
  const secondMin = end === "out" ? clampedTime(enteredMinutes + 15) : "06:00";
  const secondMax = end === "out" ? undefined : clampedTime(enteredMinutes - 15);
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

      {secondEnabled ? (
        both && second ? (
          <div className="space-y-1" data-testid={`second-hour-${end}`}>
            <div className="flex items-center justify-center gap-2">
              <span className="text-sm font-medium">{secondLabel}</span>
              <div data-field={end === "out" ? "arriveByTime" : "leaveDestTime"}>
                <TimeField15 min={secondMin} max={secondMax} value={second} onChange={changeSecond} aria-label={secondLabel} />
              </div>
              <button type="button" className="rounded-full p-1 text-muted-foreground hover:bg-muted" onClick={removeSecond}
                aria-label={he.requestSentence.secondHour.remove} data-testid={`second-hour-remove-${end}`}>
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
            {bothLine ? (
              <p className="text-center text-sm text-muted-foreground" data-testid={`second-hour-drive-${end}`}>
                {bothLine.tight ? <span className="font-medium text-amber-700 dark:text-amber-400">{he.requestSentence.secondHour.tight} · </span> : null}
                <LtrText text={bothLine.text} />
              </p>
            ) : null}
          </div>
        ) : (
          <div className="text-center">
            <button type="button" className="text-sm text-primary underline-offset-2 hover:underline" onClick={addSecond}
              data-testid={`second-hour-add-${end}`}>
              {addLabel}
            </button>
          </div>
        )
      ) : null}

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

    </div>
  );
}
