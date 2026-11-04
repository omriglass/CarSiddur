import { useEffect, useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { he } from "@/i18n/he";

/**
 * Edit mode ("עיפרון") on the member's siddur and "my rides" (owner 2026-10-30): off, a ride drags only after a long
 * press, so a ride is never moved by accident. One state for both screens, in memory only — every reopen of the app
 * starts with it off — and it turns itself off after `EDIT_MODE_IDLE_MS` without a touch (in the background too).
 * The Sadran board shares the same switch (owner 2026-11-04, REQ §13.184).
 */
export const EDIT_MODE_IDLE_MS = 5 * 60_000;

let on = false;
let lastActivity = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function setEditMode(next: boolean, now = Date.now()) {
  lastActivity = now;
  if (on === next) return;
  on = next;
  emit();
}

export function isEditMode(): boolean {
  return on;
}

/** Any touch, click or key press keeps edit mode on. */
export function noteEditModeActivity(now = Date.now()) {
  lastActivity = now;
}

/** Turns edit mode off when nothing was touched for `EDIT_MODE_IDLE_MS`; returns whether it did. */
export function expireEditMode(now = Date.now()): boolean {
  if (!on || now - lastActivity < EDIT_MODE_IDLE_MS) return false;
  setEditMode(false, now);
  return true;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** `[on, set]`; while it is on, watches activity and switches it off after the idle time (checked on return to the app too). */
export function useEditMode(): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(subscribe, isEditMode, () => false);
  useEffect(() => {
    if (!value) return;
    const touch = () => noteEditModeActivity();
    const check = () => { expireEditMode(); };
    window.addEventListener("pointerdown", touch, { capture: true, passive: true });
    window.addEventListener("keydown", touch, { capture: true });
    document.addEventListener("visibilitychange", check);
    const interval = window.setInterval(check, 30_000);
    return () => {
      window.removeEventListener("pointerdown", touch, { capture: true });
      window.removeEventListener("keydown", touch, { capture: true });
      document.removeEventListener("visibilitychange", check);
      window.clearInterval(interval);
    };
  }, [value]);
  return [value, (next) => setEditMode(next)];
}

/** Two attempts within this window make a hint; one hint per `HINT_COOLDOWN_MS`. */
const HINT_ATTEMPT_WINDOW_MS = 15_000;
const HINT_COOLDOWN_MS = 20_000;

export interface DragHintCounter {
  attempt(hint: "locked" | "notYours", now: number): "locked" | "notYours" | null;
}

/** Pure counter behind `useDragHint`: the hint to show for this attempt, if any (the second within the window). */
export function dragHintCounter(): DragHintCounter {
  let attempts: number[] = [];
  let shownAt = -Infinity;
  return {
    attempt(hint, now) {
      attempts = [...attempts.filter((at) => now - at < HINT_ATTEMPT_WINDOW_MS), now];
      if (attempts.length < 2 || now - shownAt < HINT_COOLDOWN_MS) return null;
      attempts = [];
      shownAt = now;
      return hint;
    },
  };
}

/** `WeekGrid`'s `onDragHint`: repeated attempts to drag what did not move show a toast saying why. */
export function useDragHint(): (hint: "locked" | "notYours") => void {
  const counter = useRef<DragHintCounter | null>(null);
  return (hint) => {
    counter.current ??= dragHintCounter();
    const show = counter.current.attempt(hint, Date.now());
    if (show) toast(show === "locked" ? he.editMode.hintLocked : he.editMode.hintNotYours);
  };
}
