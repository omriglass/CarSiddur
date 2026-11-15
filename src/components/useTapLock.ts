import { useCallback, useEffect, useRef } from "react";

/** How long a tap keeps its button locked when nothing else (a pending mutation) disables it. */
export const TAP_LOCK_MS = 700;

/**
 * QA run 20 R20B9: a double tap must not send the same action twice. TanStack Query sets `isPending` a tick after
 * `mutate()`, so a button disabled only by `loading` still takes a fast second tap (two tire fills, "already answered"
 * after an accept, a split that succeeds and then fails). The lock is set synchronously on the first tap and released
 * after a short moment; by then a pending mutation's `loading` keeps the button disabled.
 *
 * `resetKey` (a dialog's `open`, a wizard's step): when it changes the lock is released at once, so closing a dialog
 * and using it again right away is never mistaken for a double tap (review 2026-11-15: the second save of a reopened
 * dialog was swallowed when it came within the lock time).
 */
export function useTapLock(resetKey?: unknown): <A extends unknown[]>(handler: ((...args: A) => unknown) | undefined) => (...args: A) => void {
  const lockedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    lockedRef.current = false;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, [resetKey]);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  return useCallback(<A extends unknown[]>(handler: ((...args: A) => unknown) | undefined) => (...args: A) => {
    if (!handler || lockedRef.current) return;
    lockedRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { lockedRef.current = false; timerRef.current = null; }, TAP_LOCK_MS);
    handler(...args);
  }, []);
}
