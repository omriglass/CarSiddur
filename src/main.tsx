import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { toast } from "sonner";

import { router } from "@/app/router";
import { Toaster } from "@/components/ui/sonner";
import { SessionProvider } from "@/features/auth/SessionProvider";
import { applyTheme, getStoredPreference } from "@/hooks/useTheme";
import { he } from "@/i18n/he";
import { captureInstallPrompt } from "@/lib/installPrompt";
import { showErrorToast } from "@/lib/rpc";

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
  if (event.reason instanceof Error) {
    showErrorToast(event.reason);
  } else {
    toast.error(he.errors.unknown);
  }
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <RouterProvider router={router} />
        <Toaster />
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
