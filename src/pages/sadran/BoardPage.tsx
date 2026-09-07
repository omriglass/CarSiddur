import { Navigate } from "react-router-dom";

import { BoardScreen } from "@/features/sadran/board/components/BoardScreen";
import { t } from "@/i18n/he";

import { useSadranRouteParams } from "./useSadranRouteParams";

/** `/sadran/:dept/:week/board` — the board (UX_FLOWS.md §4.2). */
export function BoardPage() {
  const { departmentId, weekStart, isSadran, isLoading } = useSadranRouteParams();

  if (isLoading) {
    return <div className="flex min-h-[50dvh] items-center justify-center text-muted-foreground">{t("common.loading")}</div>;
  }
  if (!isSadran) return <Navigate to="/sadran" replace />;

  return <BoardScreen key={`${departmentId}:${weekStart}`} departmentId={departmentId} weekStart={weekStart} />;
}
