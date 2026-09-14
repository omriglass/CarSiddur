import { useQuery } from "@tanstack/react-query";

import { showErrorToast } from "@/lib/rpc";
import { sadranKeys } from "../keys";
import { fetchWeekExport } from "./api";
import { createWeekWorkbook } from "./weekWorkbook";

/**
 * Shared download logic, extracted so the board's kebab "actions" menu can
 * trigger the exact same export as a `DropdownMenuItem` without duplicating
 * the fetch/blob/anchor-click dance (CLAUDE.md Conventions: no duplicated
 * logic between an inline control and its menu equivalent).
 */
export function useWeekExcelExport(departmentId: string, weekStart: string) {
  const exportQuery = useQuery({
    queryKey: sadranKeys.excelExport(departmentId, weekStart),
    queryFn: () => fetchWeekExport(departmentId, weekStart), enabled: false, retry: false,
  });
  async function download() {
    try {
      const { data } = await exportQuery.refetch({ throwOnError: true });
      if (!data) return;
      const bytes = createWeekWorkbook(data);
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
  return { download, loading: exportQuery.isFetching };
}
