import { useState } from "react";
import { toast } from "sonner";

import { FormDialog } from "@/components/FormDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { he, tv } from "@/i18n/he";

import { useChecklistItemsQuery, useSubmitCarChecklistMutation } from "../hooks";
import { buildChecklistAnswers, canSubmitChecklist, EMPTY_DRAFT, type ChecklistDraftValue } from "../lib/answers";

interface Props {
  car: { id: string; name: string; department_id: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** "בדיקת רכב" — the department's active checklist items for one car (REQ item 150 d). */
export function ChecklistFormDialog({ car, open, onOpenChange }: Props) {
  const itemsQuery = useChecklistItemsQuery(open ? car.department_id : undefined);
  const mutation = useSubmitCarChecklistMutation();
  const [drafts, setDrafts] = useState<Record<string, ChecklistDraftValue>>({});
  const items = (itemsQuery.data ?? []).filter((item) => item.active);

  function patch(id: string, change: Partial<ChecklistDraftValue>) {
    setDrafts((previous) => ({ ...previous, [id]: { ...(previous[id] ?? EMPTY_DRAFT), ...change } }));
  }

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) setDrafts({});
  }

  async function submit() {
    try {
      await mutation.mutateAsync({ carId: car.id, answers: buildChecklistAnswers(items, drafts) });
      toast.success(he.carChecklist.submitted);
      close(false);
    } catch {
      // toasted by the mutation's onError
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={close}
      title={tv("carChecklist.form.title", { car: car.name })}
      description={items.length === 0 && !itemsQuery.isLoading ? he.carChecklist.form.noItems : he.carChecklist.form.help}
      submitLabel={he.carChecklist.form.submit}
      submitDisabled={!canSubmitChecklist(items, drafts)}
      loading={mutation.isPending}
      onSubmit={() => void submit()}
    >
      <div className="space-y-4" data-testid="checklist-form">
        {items.map((item) => {
          const draft = drafts[item.id] ?? EMPTY_DRAFT;
          return (
            <div key={item.id} className="space-y-2 rounded-md border p-3" data-testid="checklist-form-item">
              <p className="text-sm font-medium">
                {item.label}
                {item.required ? null : <span className="ms-2 text-xs font-normal text-muted-foreground">{he.carChecklist.form.optional}</span>}
              </p>
              {item.kind === "yes_no" ? (
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant={draft.bool === true ? "default" : "outline"} aria-pressed={draft.bool === true} onClick={() => patch(item.id, { bool: true })} data-testid="checklist-yes">
                    {he.carChecklist.form.yes}
                  </Button>
                  <Button type="button" size="sm" variant={draft.bool === false ? "destructive" : "outline"} aria-pressed={draft.bool === false} onClick={() => patch(item.id, { bool: false })} data-testid="checklist-no">
                    {he.carChecklist.form.no}
                  </Button>
                </div>
              ) : item.kind === "number" ? (
                <Input type="text" inputMode="decimal" dir="ltr" value={draft.text} onChange={(event) => patch(item.id, { text: event.target.value })} data-testid="checklist-number" />
              ) : (
                <Input type="date" dir="ltr" value={draft.text} onChange={(event) => patch(item.id, { text: event.target.value })} data-testid="checklist-date" />
              )}
              <Input placeholder={he.carChecklist.form.note} maxLength={300} value={draft.note} onChange={(event) => patch(item.id, { note: event.target.value })} />
            </div>
          );
        })}
      </div>
    </FormDialog>
  );
}
