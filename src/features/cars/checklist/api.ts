import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { rpc, toAppError } from "@/lib/rpc";

/**
 * Handover checklist (REQ item 150 d). Reads go through the tables / the `car_checklist_status` view (RLS: department
 * members), writes only through the SECURITY DEFINER RPCs. The green rule lives in `submit_car_checklist` (SQL).
 */
export type ChecklistItem = Database["public"]["Tables"]["car_checklist_items"]["Row"];
export type ChecklistItemKind = Database["public"]["Enums"]["car_checklist_item_kind"];

export interface ChecklistFailure {
  item_id: string;
  label: string;
  kind: ChecklistItemKind;
  reason: "no" | "expired";
}

/** One row of `car_checklist_status`: the latest checklist of a car (green / not green as of `completed_at`). */
export interface CarChecklistStatus {
  car_id: string;
  checklist_id: string;
  completed_at: string;
  completed_by: string;
  green: boolean;
  failures: ChecklistFailure[];
  completed_by_name?: string | null;
}

export interface ChecklistPrompt {
  car_id: string;
  profile_id: string;
  requested_at: string;
  done_at: string | null;
}

export interface ChecklistAnswerInput {
  item_id: string;
  value: boolean | number | string | null;
  note?: string;
}

export async function fetchChecklistItems(departmentId: string): Promise<ChecklistItem[]> {
  const { data, error } = await supabase
    .from("car_checklist_items")
    .select("*")
    .eq("department_id", departmentId)
    .order("position", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function fetchCarChecklistStatus(carId: string): Promise<CarChecklistStatus | null> {
  const { data, error } = await supabase
    .from("car_checklist_status")
    .select("car_id, checklist_id, completed_at, completed_by, green, failures")
    .eq("car_id", carId)
    .maybeSingle();
  if (error) throw toAppError(error);
  if (!data) return null;
  const row = data as unknown as CarChecklistStatus;
  const { data: profile } = await supabase.from("profiles").select("full_name").eq("id", row.completed_by).maybeSingle();
  return { ...row, failures: Array.isArray(row.failures) ? row.failures : [], completed_by_name: profile?.full_name ?? null };
}

/** The open handover prompts addressed to me (one per car at most). */
export async function fetchMyChecklistPrompts(profileId: string): Promise<ChecklistPrompt[]> {
  const { data, error } = await supabase
    .from("car_checklist_prompts")
    .select("car_id, profile_id, requested_at, done_at")
    .eq("profile_id", profileId)
    .is("done_at", null);
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function upsertChecklistItem(input: {
  departmentId: string;
  itemId: string | null;
  label: string;
  kind: ChecklistItemKind;
  required: boolean;
  remindDaysBefore: number | null;
  active: boolean;
}): Promise<string> {
  return rpc("upsert_car_checklist_item", {
    p_department_id: input.departmentId,
    p_item_id: input.itemId as string,
    p_label: input.label,
    p_kind: input.kind,
    p_required: input.required,
    p_remind_days_before: input.remindDaysBefore as number,
    p_active: input.active,
  });
}

export async function moveChecklistItem(itemId: string, direction: -1 | 1): Promise<void> {
  await rpc("move_car_checklist_item", { p_item_id: itemId, p_direction: direction });
}

export async function deleteChecklistItem(itemId: string): Promise<void> {
  await rpc("delete_car_checklist_item", { p_item_id: itemId });
}

export async function submitCarChecklist(carId: string, answers: ChecklistAnswerInput[]): Promise<{ green: boolean; failures: ChecklistFailure[] }> {
  const result = await rpc("submit_car_checklist", { p_car_id: carId, p_answers: answers as never });
  return result as unknown as { green: boolean; failures: ChecklistFailure[] };
}
