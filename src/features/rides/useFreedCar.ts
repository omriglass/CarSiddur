// FC1 (owner 2026-11-14, REQ item 231): the two ways a screen shows what a change that frees a shared car will cause.
//  * `useFreedCarLine(request)` — inside a confirmation that is already there (cancel a ride / a request): the line
//    appears when the answer comes within the budget, and never afterwards (no jumping text).
//  * `useFreedCarGate()` — a save that asks nothing today (ride sheet edit, a published request edit): it waits up to
//    the budget, saves at once when nobody waiting would get the car, and otherwise asks first ("הרכב יתפנה לאחרים",
//    the line, "לשמור" / "לשמור בלי להעביר את הרכב" (REQ item 237) / "חזרה").
import { useEffect, useRef, useState } from "react";

import type { FreedCarPreviewRequest } from "./api";
import { fetchFreedCarLine } from "./freedCarPreview";

/** The line for a confirmation that is open (request non-null), or null. */
export function useFreedCarLine(request: FreedCarPreviewRequest | null): string | null {
  const key = request ? JSON.stringify(request) : null;
  const [line, setLine] = useState<{ key: string; text: string | null } | null>(null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    void fetchFreedCarLine(JSON.parse(key) as FreedCarPreviewRequest).then((text) => { if (live) setLine({ key, text }); });
    return () => { live = false; };
  }, [key]);
  return line && line.key === key ? line.text : null;
}

/** The answer: "free" = go ahead (nobody affected, or "לשמור"), "keep" = go ahead but offer the hours to nobody, false = "חזרה". */
export type FreedCarAnswer = "free" | "keep" | false;

export interface FreedCarGate {
  /** Saves at once when nobody waiting would get the car (or no answer in time); otherwise asks first. */
  run: (request: FreedCarPreviewRequest | null, save: (keepOut: boolean) => void) => Promise<void>;
  /** The same as an awaitable answer. */
  ask: (request: FreedCarPreviewRequest | null) => Promise<FreedCarAnswer>;
  /** A check is running (keep the save button busy). */
  checking: boolean;
  dialog: { open: boolean; line: string; onConfirm: () => void; onKeepOut: () => void; onBack: () => void };
}

export function useFreedCarGate(): FreedCarGate {
  const [pending, setPending] = useState<{ line: string; answer: (answer: FreedCarAnswer) => void } | null>(null);
  const [checking, setChecking] = useState(false);
  const busy = useRef(false);
  async function ask(request: FreedCarPreviewRequest | null): Promise<FreedCarAnswer> {
    if (!request) return "free";
    if (busy.current) return false;
    busy.current = true;
    setChecking(true);
    let line: string | null = null;
    try {
      line = await fetchFreedCarLine(request);
    } finally {
      busy.current = false;
      setChecking(false);
    }
    if (!line) return "free";
    const text = line;
    return new Promise<FreedCarAnswer>((resolve) => setPending({ line: text, answer: resolve }));
  }
  async function run(request: FreedCarPreviewRequest | null, save: (keepOut: boolean) => void) {
    const answer = await ask(request);
    if (answer) save(answer === "keep");
  }
  function settle(answer: FreedCarAnswer) {
    const next = pending;
    setPending(null);
    next?.answer(answer);
  }
  return {
    run,
    ask,
    checking,
    dialog: { open: !!pending, line: pending?.line ?? "", onConfirm: () => settle("free"), onKeepOut: () => settle("keep"), onBack: () => settle(false) },
  };
}
