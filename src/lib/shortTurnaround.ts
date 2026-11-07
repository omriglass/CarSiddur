// REQ §13.190: on a published day a member may leave less than the turnaround before the car's next ride, after
// "תיאמתם עם X שצריך לקחת את הרכב ב-18:00?". The server names that ride (`short_turnaround` in the submit result) or
// the siddur finds it in the loaded rides; `ShortTurnaroundHost` (mounted in main.tsx) shows the one dialog.
import { z } from "zod";

import { he, tv } from "@/i18n/he";

export const shortTurnaroundSchema = z.object({
  ride_id: z.string(),
  at: z.string(),
  gap: z.number(),
  name: z.string().nullable(),
});
export type ShortTurnaroundInfo = z.infer<typeof shortTurnaroundSchema>;

/** The `short_turnaround` key of a submit/answer result, when the server named the car's next ride. */
export function parseShortTurnaround(value: unknown): ShortTurnaroundInfo | null {
  const parsed = shortTurnaroundSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function shortTurnaroundBody(info: Pick<ShortTurnaroundInfo, "at" | "name">): string {
  return tv("shortTurnaround.confirmBody", { name: info.name || he.shortTurnaround.unknownName, at: info.at });
}

export type ShortTurnaroundAsker = (info: Pick<ShortTurnaroundInfo, "at" | "name">) => Promise<boolean>;
let hostAsker: ShortTurnaroundAsker | null = null;

/** `ShortTurnaroundHost` registers the dialog here (and clears it on unmount). */
export function registerShortTurnaroundAsker(asker: ShortTurnaroundAsker | null): void {
  hostAsker = asker;
}

/** Shows the shared confirmation; `false` when no host is mounted (never shorten the turnaround without an explicit yes). */
export function askShortTurnaround(info: Pick<ShortTurnaroundInfo, "at" | "name">): Promise<boolean> {
  return hostAsker ? hostAsker(info) : Promise.resolve(false);
}
