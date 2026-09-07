import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";

import { router } from "@/app/router";
import { Toaster } from "@/components/ui/sonner";
import { SessionProvider } from "@/features/auth/SessionProvider";
import { applyTheme, getStoredPreference } from "@/hooks/useTheme";

import "@/index.css";

// Applied synchronously before the first paint so there's no flash of the
// wrong theme (the `useTheme()` hook re-applies this once Profile mounts,
// and keeps it in sync with OS changes while on "system").
applyTheme(getStoredPreference());

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
