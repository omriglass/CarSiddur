import { Navigate } from "react-router-dom";

import { paths } from "@/app/routes";
import { useDefaultSadranWeek } from "@/features/sadran/weekContext";
import { t } from "@/i18n/he";

/** Bare `/sadran` — resolves the department/week I'm Sadran of and redirects there (UX_FLOWS.md §4.1). */
export function SadranIndexPage() {
  const { data, isLoading } = useDefaultSadranWeek();

  if (isLoading) {
    return (
      <div className="flex min-h-[50dvh] items-center justify-center text-muted-foreground">{t("common.loading")}</div>
    );
  }
  if (!data) {
    return <Navigate to="/my" replace />;
  }
  return <Navigate to={paths.sadran.board(data.departmentId, data.weekStart)} replace />;
}
