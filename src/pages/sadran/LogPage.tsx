import { Navigate } from "react-router-dom";

import { ChangeLogScreen } from "@/features/sadran/log/components/ChangeLogScreen";
import { t } from "@/i18n/he";

import { useSadranRouteParams } from "./useSadranRouteParams";

/** `/sadran/:dept/:week/log` — change log (UX_FLOWS.md §4.6). */
export function LogPage() {
  const { departmentId, weekStart, isSadran, isLoading } = useSadranRouteParams();

  if (isLoading) {
    return <div className="flex min-h-[50dvh] items-center justify-center text-muted-foreground">{t("common.loading")}</div>;
  }
  if (!isSadran) return <Navigate to="/sadran" replace />;

  return <ChangeLogScreen departmentId={departmentId} weekStart={weekStart} />;
}
