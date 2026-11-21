import { ArrowDown, ArrowUp, Copy, Trash2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { FormDialog } from "@/components/FormDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useCars } from "@/features/fleet/hooks";
import { he, tv } from "@/i18n/he";

import type { CarGuide, GuideTopic } from "../api";
import { useDeleteCarGuideMutation, useDepartmentGuidesQuery, useSaveCarGuideMutation } from "../hooks";
import { cleanSteps, copyCandidates, moveItem } from "../lib/guides";

/**
 * REQ item 259: writing a car's guide in place — on a department topic (its title is the topic's) or a car's own guide
 * (any title). One text box per step, "+ שלב", ↑ ↓ ✕; "העתקה מרכב אחר" fills the steps from another car's guide
 * (same model first) for editing before saving. Saved whole by `save_car_guide`.
 */
export function GuideEditorDialog({ car, guide, topic, open, onOpenChange }: {
  car: { id: string; department_id: string };
  guide: CarGuide | null;
  topic: GuideTopic | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const topicId = guide?.topic_id ?? topic?.id ?? null;
  const [title, setTitle] = useState(guide?.title ?? topic?.title ?? "");
  const [steps, setSteps] = useState<string[]>(guide?.steps.length ? guide.steps.map((s) => s.text) : [""]);
  const [copying, setCopying] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useSaveCarGuideMutation();
  const remove = useDeleteCarGuideMutation();
  const deptGuides = useDepartmentGuidesQuery(copying ? car.department_id : undefined);
  const cars = useCars(copying ? car.department_id : undefined);
  const candidates = copying
    ? copyCandidates({ guides: deptGuides.data ?? [], cars: cars.data ?? [], carId: car.id, topicId })
    : [];
  const cleaned = cleanSteps(steps);
  const ownTitle = !topicId;

  async function submit() {
    try {
      await save.mutateAsync({ carId: car.id, guideId: guide?.id ?? null, topicId, title: title.trim(), steps: cleaned });
      toast.success(he.carGuides.editor.saved);
      onOpenChange(false);
    } catch {
      // toasted by the mutation
    }
  }

  return (
    <>
      <FormDialog
        open={open}
        onOpenChange={onOpenChange}
        title={guide ? he.carGuides.editor.edit : topic ? topic.title : he.carGuides.editor.newTitle}
        submitLabel={he.carGuides.editor.save}
        submitDisabled={cleaned.length === 0 || (ownTitle && !title.trim())}
        loading={save.isPending}
        onSubmit={() => void submit()}
      >
        <div className="space-y-3" data-testid="guide-editor">
          {ownTitle ? (
            <label className="grid gap-2 text-sm">
              {he.carGuides.editor.title}
              <Input value={title} maxLength={120} placeholder={he.carGuides.editor.titlePlaceholder}
                onChange={(e) => setTitle(e.target.value)} data-testid="guide-title" />
            </label>
          ) : guide ? (
            <p className="text-sm font-medium" dir="auto">{guide.title}</p>
          ) : null}

          {steps.map((text, i) => (
            <div key={i} className="grid gap-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{tv("carGuides.editor.step", { n: String(i + 1) })}</span>
                <div className="flex">
                  <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={he.carGuides.editor.moveUp}
                    disabled={i === 0} onClick={() => setSteps(moveItem(steps, i, -1))}>
                    <ArrowUp className="size-4" aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={he.carGuides.editor.moveDown}
                    disabled={i === steps.length - 1} onClick={() => setSteps(moveItem(steps, i, 1))}>
                    <ArrowDown className="size-4" aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={he.carGuides.editor.removeStep}
                    disabled={steps.length === 1} onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
                    <X className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              </div>
              <Textarea rows={2} maxLength={1000} value={text} dir="auto" data-testid="guide-step-input"
                onChange={(e) => setSteps(steps.map((s, j) => (j === i ? e.target.value : s)))} />
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={steps.length >= 30} onClick={() => setSteps([...steps, ""])} data-testid="guide-add-step">
              {he.carGuides.editor.addStep}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setCopying((v) => !v)} data-testid="guide-copy">
              <Copy className="me-1 size-4" aria-hidden="true" />
              {he.carGuides.editor.copyFrom}
            </Button>
          </div>

          {copying ? (
            <div className="space-y-1 rounded-lg border p-2" data-testid="guide-copy-list">
              <p className="text-xs font-medium text-muted-foreground">{he.carGuides.editor.copyTitle}</p>
              {deptGuides.isLoading || cars.isLoading ? (
                <p className="text-sm text-muted-foreground">{he.carGuides.loading}</p>
              ) : candidates.length === 0 ? (
                <p className="text-sm text-muted-foreground">{he.carGuides.editor.copyNone}</p>
              ) : (
                candidates.map((c) => (
                  <button key={c.guide.id} type="button" data-testid="guide-copy-option"
                    className="flex w-full items-center justify-between gap-2 rounded-md p-2 text-start text-sm hover:bg-accent/40"
                    onClick={() => {
                      setSteps(c.guide.steps.map((s) => s.text));
                      if (ownTitle && !title.trim()) setTitle(c.guide.title);
                      setCopying(false);
                      toast.success(he.carGuides.editor.copied);
                    }}>
                    <span className="min-w-0">
                      <span className="block font-medium">{c.carName}</span>
                      {!topicId ? <span className="block text-xs text-muted-foreground" dir="auto">{c.guide.title}</span> : null}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {[c.sameModel ? he.carGuides.editor.copySameModel : null, tv("carGuides.editor.copyStepCount", { count: String(c.guide.steps.length) })].filter(Boolean).join(" · ")}
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : null}

          {guide ? (
            <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirmDelete(true)} data-testid="guide-delete">
              <Trash2 className="me-1 size-4" aria-hidden="true" />
              {he.carGuides.editor.remove}
            </Button>
          ) : null}
        </div>
      </FormDialog>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={he.carGuides.editor.removeTitle}
        description={he.carGuides.editor.removeBody}
        confirmLabel={he.carGuides.editor.remove}
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (!guide) return;
          remove.mutate(guide.id, {
            onSuccess: () => { toast.success(he.carGuides.editor.removed); setConfirmDelete(false); onOpenChange(false); },
          });
        }}
      />
    </>
  );
}
