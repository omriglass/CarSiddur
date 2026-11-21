import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { rpc, toAppError } from "@/lib/rpc";

import { parseSteps, type GuideStep } from "./lib/guides";

/**
 * "איך עושים…" guides per car (REQ item 259). Reads: the tables and the `car_guide_missing` view (RLS: department
 * members); writes only through the SECURITY DEFINER RPCs (topics: car admins / admins; guides: `can_manage_car`).
 */
export type GuideTopic = Database["public"]["Tables"]["car_guide_topics"]["Row"];

export interface CarGuide {
  id: string;
  car_id: string;
  department_id: string;
  topic_id: string | null;
  title: string;
  steps: GuideStep[];
  updated_at: string;
}

export interface MissingGuide {
  car_id: string;
  topic_id: string;
  title: string;
  position: number;
}

const GUIDE_COLUMNS = "id, car_id, department_id, topic_id, title, steps, updated_at";

type GuideRow = Omit<CarGuide, "steps"> & { steps: unknown };
const toGuide = (row: GuideRow): CarGuide => ({ ...row, steps: parseSteps(row.steps) });

export async function fetchGuideTopics(departmentId: string): Promise<GuideTopic[]> {
  const { data, error } = await supabase
    .from("car_guide_topics")
    .select("*")
    .eq("department_id", departmentId)
    .order("position", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function fetchCarGuides(carId: string): Promise<CarGuide[]> {
  const { data, error } = await supabase.from("car_guides").select(GUIDE_COLUMNS).eq("car_id", carId);
  if (error) throw toAppError(error);
  return ((data ?? []) as GuideRow[]).map(toGuide);
}

/** Every guide of the department's cars (the /my chips and copying from another car). */
export async function fetchDepartmentGuides(departmentId: string): Promise<CarGuide[]> {
  const { data, error } = await supabase.from("car_guides").select(GUIDE_COLUMNS).eq("department_id", departmentId);
  if (error) throw toAppError(error);
  return ((data ?? []) as GuideRow[]).map(toGuide);
}

/** Which of these cars have at least one guide (the "איך עושים…" chips on /my). */
export async function fetchCarIdsWithGuides(carIds: readonly string[]): Promise<string[]> {
  if (!carIds.length) return [];
  const { data, error } = await supabase.from("car_guides").select("car_id").in("car_id", [...carIds]);
  if (error) throw toAppError(error);
  return [...new Set((data ?? []).map((row) => row.car_id))];
}

/** The required topics each shared car of the department has no guide for. */
export async function fetchMissingGuides(departmentId: string): Promise<MissingGuide[]> {
  const { data, error } = await supabase
    .from("car_guide_missing")
    .select("car_id, topic_id, title, position")
    .eq("department_id", departmentId)
    .order("position", { ascending: true });
  if (error) throw toAppError(error);
  return (data ?? []) as MissingGuide[];
}

export async function upsertGuideTopic(input: {
  departmentId: string;
  topicId: string | null;
  title: string;
  required: boolean;
  active: boolean;
}): Promise<string> {
  return rpc("upsert_car_guide_topic", {
    p_department_id: input.departmentId,
    p_topic_id: input.topicId as string,
    p_title: input.title,
    p_required: input.required,
    p_active: input.active,
  });
}

export async function moveGuideTopic(topicId: string, direction: -1 | 1): Promise<void> {
  await rpc("move_car_guide_topic", { p_topic_id: topicId, p_direction: direction });
}

export async function deleteGuideTopic(topicId: string): Promise<void> {
  await rpc("delete_car_guide_topic", { p_topic_id: topicId });
}

export async function saveCarGuide(input: {
  carId: string;
  guideId: string | null;
  topicId: string | null;
  title: string;
  steps: readonly GuideStep[];
}): Promise<string> {
  return rpc("save_car_guide", {
    p_car_id: input.carId,
    p_guide_id: input.guideId as string,
    p_topic_id: input.topicId as string,
    p_title: input.title,
    p_steps: input.steps.map((step) => ({ text: step.text })) as never,
  });
}

export async function deleteCarGuide(guideId: string): Promise<void> {
  await rpc("delete_car_guide", { p_guide_id: guideId });
}
