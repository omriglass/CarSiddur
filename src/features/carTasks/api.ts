import { supabase } from "@/integrations/supabase/client";
import { rpc, toAppError } from "@/lib/rpc";

import type { Database } from "@/integrations/supabase/types";
import type { CarTaskKind } from "@/lib/enums";

/** The only file of `features/carTasks` that calls `supabase.from()` / `.rpc()`. */
export type MyCarTask = Database["public"]["Functions"]["my_car_tasks"]["Returns"][number];

export type CarTaskRow = Database["public"]["Tables"]["car_tasks"]["Row"] & {
  requested_by_profile: { full_name: string } | null;
  done_by_profile: { full_name: string } | null;
};

/** `my_car_tasks()` — the open tasks of the rides whose window (start − 15 min … end + 15 min) contains now. */
export async function fetchMyCarTasks(): Promise<MyCarTask[]> {
  return rpc("my_car_tasks", undefined as never);
}

/** A car's tasks, newest first (managers only: RLS `can_manage_car`). */
export async function fetchCarTasks(carId: string): Promise<CarTaskRow[]> {
  const { data, error } = await supabase
    .from("car_tasks")
    .select(
      "*, requested_by_profile:profiles!car_tasks_requested_by_fkey(full_name), done_by_profile:profiles!car_tasks_done_by_fkey(full_name)",
    )
    .eq("car_id", carId)
    .order("requested_at", { ascending: false });
  if (error) throw toAppError(error);
  return (data ?? []) as unknown as CarTaskRow[];
}

/** `request_car_tasks(p_car_id, p_kinds, p_note)` — returns how many tasks were created. */
export async function requestCarTasks(input: { carId: string; kinds: CarTaskKind[]; note?: string }): Promise<number> {
  return rpc("request_car_tasks", { p_car_id: input.carId, p_kinds: input.kinds, p_note: input.note });
}

export async function withdrawCarTask(input: { taskId: string; carId: string }): Promise<void> {
  await rpc("withdraw_car_task", { p_task_id: input.taskId });
}

/** "ביצעתי" on an `other` task. */
export async function completeCarTask(taskId: string): Promise<void> {
  await rpc("complete_car_task", { p_task_id: taskId });
}
