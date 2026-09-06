import { Navigate } from "react-router-dom";

import { ClaimsScreen } from "@/features/sadran/claims/components/ClaimsScreen";
import { t } from "@/i18n/he";

import { useSadranRouteParams } from "./useSadranRouteParams";

/**
 * `/sadran/:dept/:week/claims` (and `/claims/:offerId`, reached from the push
 * notification deep link — UX_FLOWS.md §4.4). The screen itself always lists
 * every contested offer; a specific `:offerId` in the URL isn't singled out
 * (a documented simplification, see the stage 2b report) since the list is
 * usually one or two entries.
 */
export function ClaimsPage() {
  const { departmentId, weekStart, isSadran, isLoading } = useSadranRouteParams();

  if (isLoading) {
    return <div className="flex min-h-[50dvh] items-center justify-center text-muted-foreground">{t("common.loading")}</div>;
  }
  if (!isSadran) return <Navigate to="/sadran" replace />;

  return <ClaimsScreen departmentId={departmentId} weekStart={weekStart} />;
}
