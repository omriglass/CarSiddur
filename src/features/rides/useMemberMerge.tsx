// REQ §13.175 (d): the member's "take them along" — my ride dropped onto someone's pickup / drop-off on the siddur or
// "my rides". The same questions as the Sadran's merge, in order: take them along? -> the guest's time (stretch my ride,
// or take them at my ride's time) -> the long detour -> no large trunk for large luggage ("אני מודע/ת", REQ §13.175 g)
// -> "did you talk with X?" when it is not direct. Then one call.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { he, tv } from "@/i18n/he";
import { showErrorToast } from "@/lib/rpc";
import { formatTime } from "@/lib/time";

import { memberMergePreview, memberMergeRide, type BoardRide, type MemberMergePreview } from "./api";
import { MergeWaitDialog } from "./components/MergeWaitDialog";
import { invalidateWeekData } from "./invalidateWeek";
import { memberMergeAgreeNames, memberMergeWaitChoice, type MemberMergeTarget } from "./memberMerge";
import { longDetourText } from "./mergeQuestions";
import { servedOf } from "./servedOf";

type Step = "confirm" | "wait" | "detour" | "luggage" | "agree";

interface Flow {
  host: BoardRide;
  target: MemberMergeTarget;
  preview: MemberMergePreview;
  step: Step;
  wait: boolean;
}

/** Hebrew reason for a refused member merge (the board's codes, `he.mergedRide.invalid`). */
function refusal(code: string | null): string {
  const map: Record<string, string> = {
    boards_at_end: he.mergedRide.invalid.boards_at_end, seats: he.mergedRide.invalid.seats_full, luggage: he.mergedRide.invalid.luggage_needs_large_trunk,
    turnaround: he.mergedRide.invalid.turnaround_conflict, window: he.mergedRide.invalid.window, time_far: he.mergedRide.invalid.time_far,
    window_locked: he.mergedRide.invalid.window_locked, maintenance: he.mergedRide.invalid.maintenance, private_car: he.mergedRide.invalid.private_car,
    already_on_ride: he.mergedRide.invalid.already_on_ride, leg_missing: he.mergedRide.invalid.leg_missing,
  };
  return (code ? map[code] : undefined) ?? he.mergedRide.invalid.unknown;
}

export function useMemberMerge({ departmentId, weekStart, onDone }: {
  departmentId: string | undefined; weekStart: string | undefined; onDone?: () => void;
}) {
  const queryClient = useQueryClient();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [busy, setBusy] = useState(false);

  async function start(host: BoardRide, target: MemberMergeTarget) {
    if (!host.id || !target.ride.id) return;
    try {
      const preview = await memberMergePreview(host.id, target.ride.id, target.requestId);
      if (!preview.ok && !preview.waivable) {
        toast.error(refusal(preview.code));
        return;
      }
      setFlow({ host, target, preview, step: "confirm", wait: false });
    } catch (error) {
      showErrorToast(error);
    }
  }

  function next(current: Flow, after: Step) {
    const order: Step[] = ["confirm", "wait", "detour", "luggage", "agree"];
    for (const step of order.slice(order.indexOf(after) + 1)) {
      if (step === "wait" && memberMergeWaitChoice(current.preview)) return setFlow({ ...current, step });
      if (step === "detour" && current.preview.longDetour) return setFlow({ ...current, step });
      if (step === "luggage" && current.preview.luggageProblem) return setFlow({ ...current, step });
      if (step === "agree" && !(current.wait ? current.preview.directWithWait : current.preview.direct)) return setFlow({ ...current, step });
    }
    void apply(current, false);
  }

  async function apply(current: Flow, agreed: boolean) {
    const { host, target, preview, wait } = current;
    if (!host.id || host.version == null || !target.ride.id || !departmentId || !weekStart) return;
    setBusy(true);
    try {
      await memberMergeRide({ rideId: host.id, sourceRideId: target.ride.id, requestId: target.requestId, expectedVersion: host.version,
        wait, allowLongDetour: !!preview.longDetour, agreed, allowSmallTrunk: preview.luggageProblem });
      await invalidateWeekData(queryClient, departmentId, weekStart);
      toast.success(tv("rideEditing.mergeDone", { name: preview.guestName || target.name }));
      setFlow(null);
      onDone?.();
    } catch (error) {
      showErrorToast(error);
    } finally {
      setBusy(false);
    }
  }

  const close = () => setFlow(null);
  const guest = flow ? (flow.preview.guestName || flow.target.name) : "";
  const legLine = flow
    ? [flow.preview.joinerDepartAt && flow.preview.leg !== "return" ? tv("mergedRide.resultLegOut", { name: guest, place: destinationOf(flow.target), time: formatTime(new Date(flow.preview.joinerDepartAt)) }) : null,
      flow.preview.joinerReturnAt && flow.preview.leg !== "out" ? tv("mergedRide.resultLegReturn", { name: guest, place: destinationOf(flow.target), time: formatTime(new Date(flow.preview.joinerReturnAt)) }) : null]
      .filter(Boolean).join(" · ")
    : "";
  const waitChoice = flow?.step === "wait" ? memberMergeWaitChoice(flow.preview) : null;
  const names = flow ? memberMergeAgreeNames(flow.preview, flow.wait).join(", ") : "";
  const viewerName = flow?.host.driver_name ?? "";

  const element = (
    <>
      <ConfirmDialog open={flow?.step === "confirm"} onOpenChange={(open) => { if (!open) close(); }}
        title={tv("rideEditing.mergeTitle", { name: guest })} description={legLine}
        confirmLabel={he.rideEditing.mergeConfirm} loading={busy} onConfirm={() => { if (flow) next(flow, "confirm"); }} />
      {flow && waitChoice ? (
        <MergeWaitDialog choice={waitChoice} guest={guest} host={viewerName} place={destinationOf(flow.target)}
          onAnswer={(answer) => {
            if (!answer) return close();
            next({ ...flow, wait: answer === "extend" }, "wait");
          }} />
      ) : null}
      <ConfirmDialog open={flow?.step === "detour"} onOpenChange={(open) => { if (!open) close(); }}
        title={he.mergedRide.longDetourTitle}
        description={flow?.preview.longDetour ? longDetourText(flow.preview.longDetour, {
          host: viewerName, hostPlace: hostDestinationOf(flow.host), guest, guestPlace: destinationOf(flow.target), leg: flow.preview.leg,
        }) : ""}
        confirmLabel={he.mergedRide.longDetourConfirm} loading={busy} onConfirm={() => { if (flow) next(flow, "detour"); }} />
      <ConfirmDialog open={flow?.step === "luggage"} onOpenChange={(open) => { if (!open) close(); }}
        title={he.smallTrunk.confirmTitle} description={tv("rideEditing.mergeLuggageBody", { name: guest })}
        confirmLabel={he.rideEditing.mergeLuggageAware} loading={busy} onConfirm={() => { if (flow) next(flow, "luggage"); }} />
      <ConfirmDialog open={flow?.step === "agree"} onOpenChange={(open) => { if (!open) close(); }}
        title={tv("rideEditing.mergeTalkedTitle", { names })} description={tv("rideEditing.mergeTalkedBody", { names })}
        confirmLabel={he.rideEditing.mergeTalkedYes} loading={busy} onConfirm={() => { if (flow) void apply(flow, true); }} />
    </>
  );

  return { start, element };
}

/** The guest's place on the ride being taken from (their request's destination). */
function destinationOf(target: MemberMergeTarget): string {
  return servedOf(target.ride).find((entry) => entry.request_id === target.requestId)?.destination ?? target.ride.destination_name ?? "";
}

function hostDestinationOf(host: BoardRide): string {
  return servedOf(host).find((entry) => entry.role === "driver")?.destination ?? host.destination_name ?? "";
}
