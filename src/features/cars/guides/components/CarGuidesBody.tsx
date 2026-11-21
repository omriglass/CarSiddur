import { BookOpen, ChevronLeft } from "lucide-react";
import { useState } from "react";

import { PortalDialogContent } from "@/components/PortalDialogContent";
import { Button } from "@/components/ui/button";
import { Dialog, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { he, tv } from "@/i18n/he";

import { useCarGuidesQuery, useGuideTopicsQuery } from "../hooks";
import { guideRows } from "../lib/guides";

import { GuideViewer } from "./GuideViewer";

/**
 * REQ item 259: a car's guides for whoever uses it — the list ("איך עושים…"), a tap opens a guide in the step viewer,
 * "סיום" comes back to the list. Shown inside the car menu (`CarReportDialog`) and in `CarGuidesDialog` (/my, car page).
 */
export function CarGuidesBody({ carId, initialGuideId, onBack }: { carId: string; initialGuideId?: string | null; onBack?: () => void }) {
  const guidesQuery = useCarGuidesQuery(carId);
  const guides = guidesQuery.data ?? [];
  const topicsQuery = useGuideTopicsQuery(guides[0]?.department_id);
  const [openId, setOpenId] = useState<string | null>(initialGuideId ?? null);
  const rows = guideRows(topicsQuery.data ?? [], guides).flatMap((row) => (row.kind === "guide" ? [row.guide] : []));
  const open = openId ? guides.find((g) => g.id === openId) : undefined;

  if (guidesQuery.isLoading) return <p className="text-sm text-muted-foreground">{he.carGuides.loading}</p>;
  if (open) return <GuideViewer key={open.id} title={open.title} steps={open.steps} onDone={() => setOpenId(null)} />;

  return (
    <div className="grid gap-2" data-testid="car-guides-list">
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">{he.carGuides.empty}</p> : null}
      {rows.map((guide) => (
        <button
          key={guide.id}
          type="button"
          onClick={() => setOpenId(guide.id)}
          className="flex min-h-14 items-center gap-3 rounded-lg border p-3 text-start transition-smooth hover:bg-accent/40"
          data-testid="car-guide-open"
        >
          <BookOpen className="size-5 shrink-0 text-primary" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block font-medium" dir="auto">{guide.title}</span>
            <span className="block text-xs text-muted-foreground">{tv("carGuides.editor.copyStepCount", { count: String(guide.steps.length) })}</span>
          </span>
          <ChevronLeft className="size-4 shrink-0 text-muted-foreground rtl:rotate-0 ltr:rotate-180" aria-hidden="true" />
        </button>
      ))}
      {onBack ? (
        <Button type="button" variant="outline" onClick={onBack}>{he.common.back}</Button>
      ) : null}
    </div>
  );
}

/** "איך עושים…" as its own dialog (the /my chip, the car page). */
export function CarGuidesDialog({ carId, open, onOpenChange, initialGuideId }: {
  carId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialGuideId?: string | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <PortalDialogContent className="max-w-md">
        <DialogHeader className="pe-9">
          <DialogTitle>{he.carGuides.entryTitle}</DialogTitle>
        </DialogHeader>
        {open ? <CarGuidesBody carId={carId} initialGuideId={initialGuideId} /> : null}
      </PortalDialogContent>
    </Dialog>
  );
}
