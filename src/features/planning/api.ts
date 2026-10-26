import { z } from "zod";

import { supabase } from "@/integrations/supabase/client";
import { rpc, toAppError } from "@/lib/rpc";
import { weekPhaseSchema, tripTypeSchema } from "@/lib/enums";
import type { Json } from "@/integrations/supabase/types";
import type { TemplateSuggestion } from "@/features/requests/api";
import { toInstant } from "@/features/requests/mapper";
import { parseRouteStops } from "@/lib/routeStops";
import { weekdayOfDate } from "@/components/dateFieldDates";

/**
 * "תכנון קדימה" (REQ §13.154): the only file in `planning` calling `supabase.from`/`.rpc`. The month view and typical
 * usage are aggregate RPCs (`planning_month`, `typical_usage`, member_of; notes never included); a member reads and
 * writes only their own reservation rows (`save_reservation`, `cancel_reservation`, `request_templates` RLS).
 */
const partsSchema = z.object({ m: z.number(), a: z.number(), e: z.number() });
export type Parts = z.infer<typeof partsSchema>;

const daySchema = z.object({
  date: z.string(),
  phase: weekPhaseSchema.nullable(),
  available: partsSchema,
  reserved: partsSchema,
  rides: z.number(),
  requests: z.number(),
  reservationIds: z.array(z.string()),
});
export type PlanningDay = z.infer<typeof daySchema>;

const reservationSchema = z.object({
  id: z.string(),
  mine: z.boolean(),
  requesterName: z.string().nullable(),
  plannedDate: z.string(),
  plannedUntil: z.string().nullable(),
  departAt: z.string().nullable(),
  returnAt: z.string().nullable(),
  tripType: tripTypeSchema,
  tripShape: z.string(),
  destinationName: z.string().nullable(),
  originName: z.string().nullable(),
  rideTypeName: z.string().nullable(),
  adults: z.number(),
  childSeats: z.number(),
  boosters: z.number(),
  hasLuggage: z.boolean(),
  rideDescription: z.string().nullable(),
  guestNames: z.array(z.string()),
  companionNames: z.array(z.string()),
  childNames: z.array(z.string()),
  stops: z.array(z.object({ leg: z.string(), name: z.string().nullable() })),
});
export type PlanningReservation = z.infer<typeof reservationSchema>;

const monthSchema = z.object({ days: z.array(daySchema), reservations: z.array(reservationSchema) });
export type PlanningMonth = z.infer<typeof monthSchema>;

export async function fetchPlanningMonth(departmentId: string, from: string, to: string): Promise<PlanningMonth> {
  const data = await rpc("planning_month", { p_department_id: departmentId, p_from: from, p_to: to });
  return monthSchema.parse(data);
}

const usageSchema = z.object({
  weeks: z.number(),
  grid: z.array(z.object({ dow: z.number(), part: z.enum(["m", "a", "e"]), cars: z.number() })).nullable(),
});
/** Typical cars in use per weekday (0 = Sunday) and part; `null` with fewer than 4 finished weeks. */
export interface TypicalUsage {
  weeks: number;
  byDow: Parts[] | null;
}

export async function fetchTypicalUsage(departmentId: string): Promise<TypicalUsage> {
  const parsed = usageSchema.parse(await rpc("typical_usage", { p_department_id: departmentId }));
  if (!parsed.grid) return { weeks: parsed.weeks, byDow: null };
  const byDow: Parts[] = Array.from({ length: 7 }, () => ({ m: 0, a: 0, e: 0 }));
  for (const cell of parsed.grid) {
    const day = byDow[cell.dow];
    if (day) day[cell.part] = cell.cars;
  }
  return { weeks: parsed.weeks, byDow };
}

/** The department's "when is it quiet" knobs (REQ §13.154 d), as fractions. */
export interface PlanningSettings {
  full: number;
  good: number;
  weekCost: number;
  carMultiplier: number;
}

export const DEFAULT_PLANNING_SETTINGS: PlanningSettings = { full: 0.8, good: 0.75, weekCost: 0.1, carMultiplier: 1.2 };

export async function fetchPlanningSettings(departmentId: string): Promise<PlanningSettings> {
  const { data, error } = await supabase
    .from("department_settings")
    .select("planning_full_pct, planning_good_pct, planning_week_cost_pct, planning_car_multiplier")
    .eq("department_id", departmentId)
    .maybeSingle();
  if (error) throw toAppError(error);
  if (!data) return DEFAULT_PLANNING_SETTINGS;
  return {
    full: data.planning_full_pct / 100,
    good: data.planning_good_pct / 100,
    weekCost: data.planning_week_cost_pct / 100,
    carMultiplier: Number(data.planning_car_multiplier),
  };
}

export async function saveReservation(input: {
  payload: Record<string, unknown>;
  companionIds: string[];
  childIds: string[];
  reservationId?: string;
}): Promise<string> {
  return rpc("save_reservation", {
    p_payload: input.payload as Json,
    p_companion_ids: input.companionIds,
    p_child_ids: input.childIds,
    ...(input.reservationId ? { p_id: input.reservationId } : {}),
  });
}

export async function cancelReservation(reservationId: string): Promise<void> {
  await rpc("cancel_reservation", { p_id: reservationId });
}

/** The caller's own reservation as a form prefill (the same shape as a repeating-request suggestion). */
export async function fetchOwnReservation(reservationId: string): Promise<TemplateSuggestion> {
  const { data, error } = await supabase
    .from("request_templates")
    .select(`*, destination:destinations!request_templates_destination_id_fkey(name), origin:destinations!request_templates_origin_id_fkey(name), ride_type:ride_types(name_he)`)
    .eq("id", reservationId)
    .eq("schedule", "dated")
    .single();
  if (error) throw toAppError(error);
  const plannedDate = data.planned_date as string;
  const lastDay = data.planned_until ?? plannedDate;
  const weekStart = weekStartKey(plannedDate);
  const at = (day: string, time: string | null) => (time ? toInstant(day, time.slice(0, 5), false) : null);
  return {
    templateId: data.id,
    departmentId: data.department_id,
    weekStart,
    destinationId: data.destination_id,
    destinationText: data.destination_text,
    destinationName: data.destination?.name ?? null,
    rideTypeId: data.ride_type_id,
    rideTypeName: data.ride_type?.name_he ?? null,
    tripShape: data.trip_shape,
    originId: data.origin_id,
    originText: data.origin_text,
    originName: data.origin?.name ?? null,
    stops: parseRouteStops(data.stops, { includeInactive: true }),
    tripType: data.trip_type,
    departDow: data.depart_dow,
    departTime: data.depart_time,
    returnDow: data.return_dow,
    returnTime: data.return_time,
    departAt: data.depart_dow !== null ? at(plannedDate, data.depart_time) : null,
    returnAt: data.return_dow !== null ? at(lastDay, data.return_time) : null,
    oneWayCarMode: data.one_way_car_mode === "relay" || data.one_way_car_mode === "passenger" ? data.one_way_car_mode : null,
    departAnchor: data.depart_anchor,
    arriveBy: at(plannedDate, data.arrive_by_time),
    returnAnchor: data.return_anchor,
    leaveDestAt: at(lastDay, data.leave_dest_time),
    durationLocked: data.duration_locked,
    keepCarAtDestination: data.keep_car_at_destination,
    needsCarAtDestination: data.needs_car_at_destination,
    adults: data.adults,
    childSeats: data.child_seats,
    boosters: data.boosters,
    childIds: data.child_ids,
    companionIds: data.companion_ids,
    hasLuggage: data.has_luggage,
    flexDepartEarly: String(data.flex_depart_early),
    flexDepartLate: String(data.flex_depart_late),
    flexReturnEarly: String(data.flex_return_early),
    flexReturnLate: String(data.flex_return_late),
    preferredCarId: data.preferred_car_id,
    rideDescription: data.ride_description,
    guestPassengerNames: data.guest_passenger_names,
    notes: data.notes,
    schedule: "dated",
    plannedUntil: data.planned_until,
  };
}

/** The Sunday (`yyyy-MM-dd`) of the week holding calendar date `date`. */
export function weekStartKey(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - weekdayOfDate(date));
  return d.toISOString().slice(0, 10);
}
