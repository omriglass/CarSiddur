import { Navigate } from "react-router-dom";

import { PublishScreen } from "@/features/sadran/publish/components/PublishScreen";
import { t } from "@/i18n/he";

import { useSadranRouteParams } from "./useSadranRouteParams";

/** `/sadran/:dept/:week/publish` — publish confirmation (UX_FLOWS.md §4.5). */
export function PublishPage() {
  const { departmentId, weekStart, isSadran, isLoading } = useSadranRouteParams();

  if (isLoading) {
    return <div className="flex min-h-[50dvh] items-center justify-center text-muted-foreground">{t("common.loading")}</div>;
  }
  if (!isSadran) return <Navigate to="/sadran" replace />;

  return <PublishScreen departmentId={departmentId} weekStart={weekStart} />;
}
