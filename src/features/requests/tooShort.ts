import { timeToMinutes } from "./duration";

/**
 * R13B16 (owner 2026-10-23): a same-day round trip whose car window is shorter than the drive there and
 * back cannot happen as asked. The form warns (it never refuses); the answer is the drive in minutes,
 * or null when the window is long enough or a drive is not known yet.
 */
export function roundTripTooShort(input: {
  tripType: string;
  departTime: string | undefined;
  returnTime: string | undefined;
  outMinutes: number | null;
  returnMinutes: number | null;
}): number | null {
  const { tripType, departTime, returnTime, outMinutes, returnMinutes } = input;
  if (tripType !== "round_trip" || !departTime || !returnTime || outMinutes == null || returnMinutes == null) return null;
  const window = timeToMinutes(returnTime) - timeToMinutes(departTime);
  const drive = Math.round(outMinutes + returnMinutes);
  return window > 0 && window < drive ? drive : null;
}
