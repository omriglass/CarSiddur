import type { MyCarTask } from "../api";

/** A task's window around its ride: from 15 minutes before the start to 15 minutes after the end (REQ item 150 b). */
export const TASK_WINDOW_MINUTES = 15;

const MINUTE_MS = 60_000;

/** Pure mirror of the server's rule, so a card that stays open past its window disappears without waiting for a refetch. */
export function taskInWindow(task: Pick<MyCarTask, "ride_starts_at" | "ride_ends_at">, nowMs: number): boolean {
  const start = new Date(task.ride_starts_at).getTime() - TASK_WINDOW_MINUTES * MINUTE_MS;
  const end = new Date(task.ride_ends_at).getTime() + TASK_WINDOW_MINUTES * MINUTE_MS;
  return nowMs >= start && nowMs <= end;
}

/**
 * The tasks to show now. `rideId` limits them to one ride (the ride sheet); without it each task appears once
 * (a task can belong to two rides with overlapping windows on /my), under its earliest ride.
 */
export function visibleTasks<T extends Pick<MyCarTask, "task_id" | "ride_id" | "ride_starts_at" | "ride_ends_at">>(
  tasks: readonly T[],
  nowMs: number,
  rideId?: string,
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const task of tasks) {
    if (!taskInWindow(task, nowMs)) continue;
    if (rideId !== undefined && task.ride_id !== rideId) continue;
    if (rideId === undefined) {
      if (seen.has(task.task_id)) continue;
      seen.add(task.task_id);
    }
    result.push(task);
  }
  return result;
}

/** Groups tasks by car, keeping the given order. */
export function groupTasksByCar<T extends Pick<MyCarTask, "car_id">>(tasks: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const task of tasks) {
    const group = groups.get(task.car_id);
    if (group) group.push(task);
    else groups.set(task.car_id, [task]);
  }
  return [...groups.values()];
}
