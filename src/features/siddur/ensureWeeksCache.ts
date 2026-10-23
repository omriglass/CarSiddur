/**
 * `ensure_department_weeks` is a catch-up write ("make sure this department's week rows exist"),
 * not something every week read needs. Run it at most once per department per session; a
 * long-lived PWA re-runs it after `ENSURE_WEEKS_TTL_MS` so a rollover while the app stays open is
 * still caught (the cron also creates weeks). Cleared on sign-out. A failed run is not remembered.
 */
export const ENSURE_WEEKS_TTL_MS = 30 * 60_000;

const ensured = new Map<string, { at: number; promise: Promise<void> }>();

export function ensureOncePerSession(
  departmentId: string,
  run: (departmentId: string) => Promise<void>,
  now: number = Date.now(),
): Promise<void> {
  const cached = ensured.get(departmentId);
  if (cached && now - cached.at < ENSURE_WEEKS_TTL_MS) return cached.promise;
  const promise = run(departmentId);
  ensured.set(departmentId, { at: now, promise });
  promise.catch(() => {
    if (ensured.get(departmentId)?.promise === promise) ensured.delete(departmentId);
  });
  return promise;
}

export function resetEnsuredWeeks(): void {
  ensured.clear();
}
