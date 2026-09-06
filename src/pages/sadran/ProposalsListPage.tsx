import { Navigate } from "react-router-dom";

import { ProposalsListScreen } from "@/features/sadran/proposals/components/ProposalsListScreen";
import { t } from "@/i18n/he";

import { useSadranRouteParams } from "./useSadranRouteParams";

/** `/sadran/:dept/:week/proposals` (UX_FLOWS.md §4.3 proposals list). */
export function ProposalsListPage() {
  const { departmentId, weekStart, isSadran, isLoading } = useSadranRouteParams();

  if (isLoading) {
    return <div className="flex min-h-[50dvh] items-center justify-center text-muted-foreground">{t("common.loading")}</div>;
  }
  if (!isSadran) return <Navigate to="/sadran" replace />;

  return <ProposalsListScreen departmentId={departmentId} weekStart={weekStart} />;
}
