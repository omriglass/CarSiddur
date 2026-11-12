// PF1 DC2b/DC2c (docs/PF1_PLAN_2026-11.md §12): the reads of one department-week that start together travel as
// ONE `week_parts` call.
//
// A screen keeps its separate queries (rides, requests, proposals, …), each with its own cache key. When several
// of them start within `windowMs` — a screen opening, or the refresh after a change — their parts are collected
// and asked for in a single call; each query gets its own part back, or its own error.
//
// A read never joins a call that is already on its way: that call may have read the database before the change
// that caused this read. It waits for the next one, so every answer is at least as new as its question.
export interface WeekPartError {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
}

/** One part's answer from `week_parts()`: its rows, or the error that part alone raised. */
export interface WeekPartAnswer {
  data?: unknown;
  error?: WeekPartError;
}

export interface WeekPartsBatcherOptions {
  fetch: (departmentId: string, weekStart: string, parts: string[]) => Promise<Record<string, WeekPartAnswer | undefined>>;
  windowMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

interface Waiter {
  resolve: (data: unknown) => void;
  reject: (error: unknown) => void;
}

export function createWeekPartsBatcher(options: WeekPartsBatcherOptions) {
  const windowMs = options.windowMs ?? 10;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const open = new Map<string, Map<string, Waiter[]>>();

  async function send(departmentId: string, weekStart: string, waiting: Map<string, Waiter[]>): Promise<void> {
    const settle = (part: string, act: (waiter: Waiter) => void) => (waiting.get(part) ?? []).forEach(act);
    let answers: Record<string, WeekPartAnswer | undefined>;
    try {
      answers = await options.fetch(departmentId, weekStart, [...waiting.keys()]);
    } catch (error) {
      for (const part of waiting.keys()) settle(part, (waiter) => waiter.reject(error));
      return;
    }
    for (const part of waiting.keys()) {
      const answer = answers[part];
      if (!answer) settle(part, (waiter) => waiter.reject({ code: "week_part_missing", message: `week_parts returned no "${part}"` }));
      else if (answer.error) settle(part, (waiter) => waiter.reject(answer.error));
      else settle(part, (waiter) => waiter.resolve(answer.data ?? null));
    }
  }

  return {
    /** One part of one department-week; rejects with that part's `WeekPartError` (or the call's own error). */
    read(departmentId: string, weekStart: string, part: string): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const key = `${departmentId}|${weekStart}`;
        let waiting = open.get(key);
        if (!waiting) {
          const batch = new Map<string, Waiter[]>();
          waiting = batch;
          open.set(key, batch);
          setTimer(() => {
            open.delete(key);
            void send(departmentId, weekStart, batch);
          }, windowMs);
        }
        const waiters = waiting.get(part) ?? [];
        waiters.push({ resolve, reject });
        waiting.set(part, waiters);
      });
    },
  };
}
