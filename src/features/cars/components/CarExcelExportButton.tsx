import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { he } from "@/i18n/he";

import { createCarWorkbook } from "../export/carWorkbook";

import type { CarCareEventWithReporter, CarIssueWithReporter } from "../api";

interface CarExcelExportButtonProps {
  carName: string;
  issues: readonly CarIssueWithReporter[];
  careEvents: readonly CarCareEventWithReporter[];
  loading?: boolean;
}

/** One workbook, three sheets ("תקלות"/"מילוי אוויר"/"שטיפות"), same download pattern as `WeekExcelExportButton`. */
export function CarExcelExportButton({ carName, issues, careEvents, loading = false }: CarExcelExportButtonProps) {
  function download() {
    const bytes = createCarWorkbook(issues, careEvents);
    const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${carName}-history.xlsx`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <Button variant="outline" size="sm" onClick={download} disabled={loading}>
      <Download className="me-1 size-4" aria-hidden="true" />
      {loading ? he.carPage.exportLoading : he.carPage.exportButton}
    </Button>
  );
}
