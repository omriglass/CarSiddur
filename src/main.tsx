import { DirectionProvider } from "@radix-ui/react-direction";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { toast } from "sonner";

import { router } from "@/app/router";
import { SmallTrunkHost } from "@/components/SmallTrunkHost";
import { Toaster } from "@/components/ui/sonner";
import { SessionProvider } from "@/features/auth/SessionProvider";
import { errorToReport, reportClientError } from "@/features/diagnostics/reportClientError";
import { applyTheme, getStoredPreference } from "@/hooks/useTheme";
import { he } from "@/i18n/he";
import { captureInstallPrompt } from "@/lib/installPrompt";
import { createQueryClient } from "@/lib/queryPolicy";
import { AppError, showErrorToast } from "@/lib/rpc";

import "@/index.css";

// Applied synchronously before the first paint so there's no flash of the
// wrong theme (the `useTheme()` hook re-applies this once Profile mounts,
// and keeps it in sync with OS changes while on "system").
applyTheme(getStoredPreference());
captureInstallPrompt();

// Last-resort net for a promise rejection nothing else caught (CLAUDE.md hard
// rule 2, docs/UX_FLOWS.md §2.3): TanStack Query mutations already toast their
// own errors via `onError`/`showErrorToast` and never reach here as an
// *unhandled* rejection, so this mainly covers stray `await`s outside that
// path. `AppError`/`Error` reasons get the normal Hebrew mapping; anything
// else (a rejected non-Error value) falls back to the generic error toast.
window.addEventListener("unhandledrejection", (event) => {
  // E1 (docs/ARCHITECTURE.md §12): every unhandled rejection reaches `client_errors`, except an
  // `AppError` — those already went through `toAppError`, which reports only the unexpected ones.
  if (!(event.reason instanceof AppError)) {
    reportClientError(errorToReport(event.reason, "unhandledrejection"));
  }
  if (event.reason instanceof Error) {
    showErrorToast(event.reason);
  } else {
    toast.error(he.errors.unknown);
  }
});

// A page opened before a deploy asks for a lazy chunk the new build no longer has; the Worker answers with
// index.html ("'text/html' is not a valid JavaScript MIME type", 2026-10-13). Reload once to pick up the new
// build instead of showing the error screen; a second failure within a minute is a real error and falls through.
window.addEventListener("vite:preloadError", (event) => {
  const key = "app.chunkReloadAt";
  try {
    const last = Number(sessionStorage.getItem(key) ?? 0);
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});

// An installed app can stay open in the background for days on an old build (client_errors 2026-10-14 came
// from builds 2–5 days old). Coming back to the foreground asks for a newer service worker (at most every
// 5 minutes); once a new build has taken over, the page reloads the next time it is hidden - never on a
// form (`/new`, `/edit`), so an unsent request is not lost; the chunk handler above covers the rest.
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let newBuild = false;
  let lastCheck = Date.now();
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController) newBuild = true;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (newBuild && !/\/(new|edit)$/.test(window.location.pathname)) window.location.reload();
      return;
    }
    if (Date.now() - lastCheck < 5 * 60_000) return;
    lastCheck = Date.now();
    navigator.serviceWorker.getRegistration().then((registration) => registration?.update()).catch(() => undefined);
  });
}

// Uncaught synchronous exceptions outside React's render (event handlers, timers, scripts).
window.addEventListener("error", (event) => {
  const where = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined;
  reportClientError(
    event.error !== undefined && event.error !== null
      ? errorToReport(event.error, where ? `window.error ${where}` : "window.error")
      : { message: event.message, context: where ? `window.error ${where}` : "window.error" },
  );
});

const queryClient = createQueryClient();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found");
}

// Radix primitives (Select, ToggleGroup, DropdownMenu, Tabs, …) resolve their direction
// with `useDirection()`, which falls back to `ltr` when no provider is mounted — each of
// them then stamps `dir="ltr"` on its own DOM root, overriding the ambient
// `<html dir="rtl">` (owner bug report 2026-09-14: ride-type chips and the preferred-car
// select rendered left-to-right). One provider here fixes every primitive app-wide.
createRoot(rootElement).render(
  <StrictMode>
    <DirectionProvider dir="rtl">
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <RouterProvider router={router} />
          <Toaster position="top-center" />
          <SmallTrunkHost />
        </SessionProvider>
      </QueryClientProvider>
    </DirectionProvider>
  </StrictMode>,
);
