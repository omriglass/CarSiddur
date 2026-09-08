import { useSyncExternalStore } from "react";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let pending: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

// Capture before React/auth finishes loading; the browser only emits this once.
export function captureInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    pending = event as InstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    pending = null;
    emit();
  });
}

export function useInstallPrompt() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => pending, () => null);
}

export function clearInstallPrompt() {
  pending = null;
  emit();
}
