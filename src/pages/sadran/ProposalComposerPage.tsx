import { Navigate } from "react-router-dom";

import { ProposalComposerScreen } from "@/features/sadran/proposals/components/ProposalComposerScreen";
import { t } from "@/i18n/he";

import { useSadranRouteParams } from "./useSadranRouteParams";

/** `/sadran/:dept/:week/proposals/new` — proposal composer (UX_FLOWS.md §4.3). */
export function ProposalComposerPage() {
  const { departmentId, weekStart, isSadran, isLoading } = useSadranRouteParams();

  if (isLoading) {
    return <div className="flex min-h-[50dvh] items-center justify-center text-muted-foreground">{t("common.loading")}</div>;
  }
  if (!isSadran) return <Navigate to="/sadran" replace />;

  return <ProposalComposerScreen departmentId={departmentId} weekStart={weekStart} />;
}
