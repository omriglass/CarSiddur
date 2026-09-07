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
      <span className="flex size-14 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="size-7 text-destructive" aria-hidden="true" />
      </span>
      <p className="text-muted-foreground">{t("errorState.title")}</p>
      {onRetry ? <Button onClick={onRetry}>{t("errorState.refresh")}</Button> : null}
    </div>
  );
}
