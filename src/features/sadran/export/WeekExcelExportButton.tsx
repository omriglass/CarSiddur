import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { he } from "@/i18n/he";
import { showErrorToast } from "@/lib/rpc";
import { fetchWeekExport } from "./api";
import { createWeekWorkbook } from "./weekWorkbook";

/** Export current persisted week data on demand, independently of board/day filters. */
export function WeekExcelExportButton({ departmentId, weekStart }: { departmentId: string; weekStart: string }) {
  const exportQuery = useQuery({
    queryKey: ["sadran", departmentId, weekStart, "excelExport"],
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
  return <Button variant="outline" size="sm" onClick={() => void download()} disabled={exportQuery.isFetching}>
    <Download className="me-1 size-4" />{exportQuery.isFetching ? he.excelExport.loading : he.excelExport.button}
  </Button>;
}
