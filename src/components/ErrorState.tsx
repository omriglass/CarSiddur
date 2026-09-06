import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n/he";

interface ErrorStateProps {
  onRetry?: () => void;
}

/** Full-screen error, only when a route cannot render at all (UX_FLOWS.md §7.2). */
export function ErrorState({ onRetry }: ErrorStateProps) {
  return (
    <div className="flex min-h-[50dvh] flex-col items-center justify-center gap-4 p-8 text-center">
      <AlertTriangle className="size-10 text-destructive" aria-hidden="true" />
      <p className="text-muted-foreground">{t("errorState.title")}</p>
      {onRetry ? <Button onClick={onRetry}>{t("errorState.refresh")}</Button> : null}
    </div>
  );
}
