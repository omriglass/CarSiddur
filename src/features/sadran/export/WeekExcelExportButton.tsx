import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { he } from "@/i18n/he";
import { useWeekExcelExport } from "./useWeekExcelExport";

/** Export current persisted week data on demand, independently of board/day filters. */
export function WeekExcelExportButton({ departmentId, weekStart }: { departmentId: string; weekStart: string }) {
  const { download, loading } = useWeekExcelExport(departmentId, weekStart);
  return <Button variant="outline" size="sm" onClick={() => void download()} disabled={loading}>
    <Download className="me-1 size-4" />{loading ? he.excelExport.loading : he.excelExport.button}
  </Button>;
}
