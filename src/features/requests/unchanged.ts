// R11B1 / R11F1: "nothing changed" check for the edit form. RHF's `isDirty` is not enough (effects write fields
// back, e.g. the anchor sync re-derives `departTime`), so the edited values and the loaded request are both
// reduced to the same normalized signature — the submit payload without its bookkeeping keys, plus the fields
// that are saved through other RPCs (companions, named children, repeat weekly).
import { guestPassengerNames } from "./quickRequest";
import { toSubmitRequestPayload } from "./mapper";
import type { RequestFormValues } from "./schema";

export interface EditSignatureOptions {
  /** Sentence weekly layout: an anchored end's car time is derived, so the typed anchor time stands for it. */
  anchorSync: boolean;
}

export function editSignature(values: RequestFormValues, options: EditSignatureOptions): string {
  const payload: Record<string, unknown> = {
    ...toSubmitRequestPayload(values, { layout: "sentence", planB: true, guestPassengerNames: guestPassengerNames(values.guestNames) }),
  };
  delete payload.request_id;
  delete payload.expected_version;
  if (options.anchorSync && values.departAnchor === "arrive") delete payload.depart_at;
  if (options.anchorSync && values.returnAnchor === "leave") delete payload.return_at;
  return JSON.stringify({
    payload,
    companions: [...values.companions].sort(),
    children: [...values.children].sort(),
    extraAdults: values.extraAdults ?? 0,
    legacyChildSeats: values.legacyChildSeats ?? 0,
    repeatWeekly: !!values.repeatWeekly,
  });
}

/** Whether saving `current` would change nothing compared with the `baseline` signature of the loaded request. */
export function isUnchangedEdit(current: RequestFormValues, baseline: string | null, options: EditSignatureOptions): boolean {
  return baseline !== null && editSignature(current, options) === baseline;
}
