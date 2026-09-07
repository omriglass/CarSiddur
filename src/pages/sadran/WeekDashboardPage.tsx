import { Navigate } from "react-router-dom";

import { t } from "@/i18n/he";

import { useSadranRouteParams } from "./useSadranRouteParams";

/** `/sadran/:dept/:week` — week dashboard (UX_FLOWS.md §4.1). */
export function WeekDashboardPage() {
  const { departmentId, weekStart, isSadran, isLoading } = useSadranRouteParams();

  if (isLoading) {
    return <div className="flex min-h-[50dvh] items-center justify-center text-muted-foreground">{t("common.loading")}</div>;
  }
  if (!isSadran) return <Navigate to="/sadran" replace />;

  return <Navigate to={`/sadran/${departmentId}/${weekStart}/board`} replace />;
}
