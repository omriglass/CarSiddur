import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { he } from "@/i18n/he";
import { showErrorToast } from "@/lib/rpc";

import { fetchBoardRides, fetchExportCarNames } from "../api";
import { createMemberWeekWorkbook } from "../export/memberWeekWorkbook";
import { siddurKeys } from "../queryKeys";

/**
 * Per-row export button on `SiddurArchivePage` — same Excel format as the
 * Sadran board's `WeekExcelExportButton` (`src/features/sadran/export`) but
 * built only from member-readable data (see `memberWeekWorkbook.ts` for
 * exactly what is left out and why).
 */
export function MemberWeekExportButton({ departmentId, weekStart }: { departmentId: string; weekStart: string }) {
  const exportQuery = useQuery({
    queryKey: siddurKeys.weekExport(departmentId, weekStart),
    queryFn: async () => {
      const [rides, cars] = await Promise.all([
        fetchBoardRides(departmentId, weekStart),
        fetchExportCarNames(departmentId),
      ]);
      return { departmentId, weekStart, rides, cars };
    },
    enabled: false,
    retry: false,
  });

  async function download() {
    try {
      const { data } = await exportQuery.refetch({ throwOnError: true });
      if (!data) return;
      const bytes = createMemberWeekWorkbook(data);
      const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `siddur-${weekStart}-${departmentId}.xlsx`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { showErrorToast(error); }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={(event) => { event.stopPropagation(); void download(); }}
      disabled={exportQuery.isFetching}
      data-testid="siddur-archive-export"
    >
      <Download className="me-1 size-4" aria-hidden="true" />
      {exportQuery.isFetching ? he.excelExport.loading : he.excelExport.button}
    </Button>
  );
}
