import { useCallback, useRef } from "react";

/** How long a tap keeps its button locked when nothing else (a pending mutation) disables it. */
export const TAP_LOCK_MS = 700;

/**
 * QA run 20 R20B9: a double tap must not send the same action twice. TanStack Query sets `isPending` a tick after
 * `mutate()`, so a button disabled only by `loading` still takes a fast second tap (two tire fills, "already answered"
 * after an accept, a split that succeeds and then fails). The lock is set synchronously on the first tap and released
 * after a short moment; by then a pending mutation's `loading` keeps the button disabled.
 */
export function useTapLock(): <A extends unknown[]>(handler: ((...args: A) => unknown) | undefined) => (...args: A) => void {
  const lockedRef = useRef(false);
  return useCallback(<A extends unknown[]>(handler: ((...args: A) => unknown) | undefined) => (...args: A) => {
    if (!handler || lockedRef.current) return;
    lockedRef.current = true;
    setTimeout(() => { lockedRef.current = false; }, TAP_LOCK_MS);
    handler(...args);
  }, []);
}
