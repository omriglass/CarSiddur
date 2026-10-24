import { ArrowDown, ArrowUp, ClipboardCheck, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { FormDialog } from "@/components/FormDialog";
import { PageHeader } from "@/components/PageHeader";
import { CardListSkeleton } from "@/components/skeletons/CardListSkeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useMyDepartments } from "@/features/auth/useMyDepartments";
import { useProfile } from "@/features/auth/useProfile";
import { he, tv } from "@/i18n/he";

import type { ChecklistItem, ChecklistItemKind } from "../api";
import {
  useChecklistItemsQuery,
  useDeleteChecklistItemMutation,
  useMoveChecklistItemMutation,
  useUpsertChecklistItemMutation,
} from "../hooks";

const KINDS: readonly ChecklistItemKind[] = ["yes_no", "number", "date"];

interface Draft {
  itemId: string | null;
  label: string;
  kind: ChecklistItemKind;
  required: boolean;
  active: boolean;
  remind: string;
}

const NEW_DRAFT: Draft = { itemId: null, label: "", kind: "yes_no", required: true, active: true, remind: "" };

/**
 * `/cars/checklist/:dept` — the department's handover checklist (REQ item 150 d). Reachable by the department's car
 * administrators and admins (a car admin need not be a Sadran or admin, so it is a member route, not under /admin).
 * RLS-equivalent gating is in `can_define_car_checklist`; this screen only mirrors it.
 */
export function ChecklistEditorScreen({ departmentId }: { departmentId: string }) {
  const profile = useProfile().data;
  const departments = useMyDepartments().data ?? [];
  const canDefine = !!profile?.is_admin || departments.some((m) => m.department_id === departmentId && m.is_car_admin);
  const itemsQuery = useChecklistItemsQuery(canDefine ? departmentId : undefined);
  const upsert = useUpsertChecklistItemMutation();
  const move = useMoveChecklistItemMutation();
  const remove = useDeleteChecklistItemMutation();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [toRemove, setToRemove] = useState<ChecklistItem | null>(null);
  const items = itemsQuery.data ?? [];

  if (!canDefine) {
    return (
      <div className="mx-auto max-w-2xl p-4">
        <EmptyState icon={ClipboardCheck} message={he.carChecklist.editor.notAllowed} />
      </div>
    );
  }

  const remindDays = draft && draft.kind === "date" && draft.remind.trim() !== "" ? Number(draft.remind) : null;
  const remindValid = remindDays === null || (Number.isInteger(remindDays) && remindDays >= 0 && remindDays <= 365);

  async function save() {
    if (!draft) return;
    try {
      await upsert.mutateAsync({
        departmentId,
        itemId: draft.itemId,
        label: draft.label.trim(),
        kind: draft.kind,
        required: draft.required,
        remindDaysBefore: draft.kind === "date" ? remindDays : null,
        active: draft.active,
      });
      toast.success(he.carChecklist.editor.saved);
      setDraft(null);
    } catch {
      // toasted by the mutation
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 pb-24" data-testid="checklist-editor">
      <PageHeader
        title={he.carChecklist.editor.title}
        actions={
          <Button size="sm" onClick={() => setDraft(NEW_DRAFT)} data-testid="checklist-add">
            <Plus className="me-1 size-4" aria-hidden="true" />
            {he.carChecklist.editor.add}
          </Button>
        }
      />
      <p className="text-sm text-muted-foreground">{he.carChecklist.editor.help}</p>
      {itemsQuery.isLoading ? (
        <CardListSkeleton count={3} />
      ) : items.length === 0 ? (
        <EmptyState icon={ClipboardCheck} message={he.carChecklist.editor.empty} />
      ) : (
        <div className="space-y-2">
          {items.map((item, index) => (
            <Card key={item.id} className="bg-gradient-card shadow-card" data-testid="checklist-item">
              <CardContent className="flex items-center justify-between gap-2 p-3 text-sm">
                <div className="space-y-1">
                  <p className="font-medium">{item.label}</p>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="secondary">{he.carChecklist.kindLabel[item.kind]}</Badge>
                    {item.required ? <Badge variant="outline">{he.carChecklist.editor.requiredBadge}</Badge> : null}
                    {!item.active ? <Badge variant="outline">{he.carChecklist.editor.inactive}</Badge> : null}
                    {item.remind_days_before !== null ? (
                      <Badge variant="outline">{tv("carChecklist.editor.remindBadge", { days: String(item.remind_days_before) })}</Badge>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center">
                  <Button variant="ghost" size="icon" aria-label={he.carChecklist.editor.moveUp} disabled={index === 0 || move.isPending} onClick={() => move.mutate({ itemId: item.id, direction: -1 })}>
                    <ArrowUp className="size-4" aria-hidden="true" />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label={he.carChecklist.editor.moveDown} disabled={index === items.length - 1 || move.isPending} onClick={() => move.mutate({ itemId: item.id, direction: 1 })}>
                    <ArrowDown className="size-4" aria-hidden="true" />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label={he.carChecklist.editor.edit} data-testid="checklist-item-edit"
                    onClick={() => setDraft({ itemId: item.id, label: item.label, kind: item.kind, required: item.required, active: item.active, remind: item.remind_days_before === null ? "" : String(item.remind_days_before) })}>
                    <Pencil className="size-4" aria-hidden="true" />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label={he.carChecklist.editor.remove} onClick={() => setToRemove(item)}>
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <FormDialog
        open={draft !== null}
        onOpenChange={(next) => !next && setDraft(null)}
        title={draft?.itemId ? he.carChecklist.editor.edit : he.carChecklist.editor.add}
        submitLabel={he.carChecklist.editor.save}
        submitDisabled={!draft || draft.label.trim() === "" || !remindValid}
        loading={upsert.isPending}
        onSubmit={() => void save()}
      >
        {draft ? (
          <div className="space-y-3">
            <label className="grid gap-2 text-sm">
              {he.carChecklist.editor.label}
              <Input value={draft.label} maxLength={120} onChange={(event) => setDraft({ ...draft, label: event.target.value })} data-testid="checklist-item-label" />
            </label>
            <div className="grid gap-2 text-sm">
              <Label>{he.carChecklist.editor.kind}</Label>
              <Select value={draft.kind} onValueChange={(value) => setDraft({ ...draft, kind: value as ChecklistItemKind, remind: value === "date" ? draft.remind : "" })}>
                <SelectTrigger data-testid="checklist-item-kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {KINDS.map((kind) => <SelectItem key={kind} value={kind}>{he.carChecklist.kindLabel[kind]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {draft.kind === "date" ? (
              <label className="grid gap-2 text-sm">
                {he.carChecklist.editor.remind}
                <Input type="text" inputMode="numeric" dir="ltr" value={draft.remind} onChange={(event) => setDraft({ ...draft, remind: event.target.value })} data-testid="checklist-item-remind" />
                <span className="text-xs text-muted-foreground">{he.carChecklist.editor.remindHelp}</span>
              </label>
            ) : null}
            <div className="flex items-center justify-between text-sm">
              <Label htmlFor="checklist-required">{he.carChecklist.editor.required}</Label>
              <Switch id="checklist-required" checked={draft.required} onCheckedChange={(checked) => setDraft({ ...draft, required: checked })} />
            </div>
            <div className="flex items-center justify-between text-sm">
              <Label htmlFor="checklist-active">{he.carChecklist.editor.active}</Label>
              <Switch id="checklist-active" checked={draft.active} onCheckedChange={(checked) => setDraft({ ...draft, active: checked })} />
            </div>
          </div>
        ) : null}
      </FormDialog>

      <ConfirmDialog
        open={toRemove !== null}
        onOpenChange={(next) => !next && setToRemove(null)}
        title={he.carChecklist.editor.removeTitle}
        description={he.carChecklist.editor.removeBody}
        confirmLabel={he.carChecklist.editor.remove}
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (!toRemove) return;
          remove.mutate(toRemove.id, {
            onSuccess: () => { toast.success(he.carChecklist.editor.removed); setToRemove(null); },
          });
        }}
      />
    </div>
  );
}
