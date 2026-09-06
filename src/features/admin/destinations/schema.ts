import { z } from "zod";

export const destinationSchema = z.object({
  name: z.string().trim().min(1),
  aliasesText: z.string(),
  zone: z.string().trim().min(1),
  distance_km: z.number().min(0).nullable(),
  travel_minutes: z.number().int().min(0).nullable(),
  public_transport_score: z.number().int().min(0).max(5).nullable(),
  is_approved: z.boolean(),
});
export type DestinationFormValues = z.infer<typeof destinationSchema>;

export function aliasesTextToArray(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
