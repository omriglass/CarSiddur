import { z } from "zod";
import { he } from "@/i18n/he";

export const destinationSchema = z.object({
  name: z.string().trim().min(1),
  aliasesText: z.string(),
  zone: z.string().trim().min(1),
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
  distance_km: z.number().min(0).nullable(),
  travel_minutes: z.number().int().min(0).nullable(),
  public_transport_score: z.number().int().min(0).max(5).nullable(),
  is_approved: z.boolean(),
}).refine((values) => (values.lat === null) === (values.lng === null), {
  message: he.adminDestinations.coordinatesPair, path: ["lng"],
});
export type DestinationFormValues = z.infer<typeof destinationSchema>;

export function aliasesTextToArray(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
