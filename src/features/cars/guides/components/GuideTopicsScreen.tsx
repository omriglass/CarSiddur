import { ArrowDown, ArrowUp, BookOpen, Pencil, Plus, Trash2 } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { useMyDepartments } from "@/features/auth/useMyDepartments";
import { useProfile } from "@/features/auth/useProfile";
import { he } from "@/i18n/he";

import type { GuideTopic } from "../api";
import { useDeleteGuideTopicMutation, useGuideTopicsQuery, useMoveGuideTopicMutation, useUpsertGuideTopicMutation } from "../hooks";

interface Draft { topicId: string | null; title: string; required: boolean; active: boolean }
const NEW_DRAFT: Draft = { topicId: null, title: "", required: true, active: true };

/**
 * `/cars/guides/:dept` — the department's guide topics (REQ item 259): what guides every shared car needs, each
 * required or optional. Car administrators and admins (`can_define_car_checklist`); this screen only mirrors it.
 */
export function GuideTopicsScreen({ departmentId }: { departmentId: string }) {
  const profile = useProfile().data;
  const departments = useMyDepartments().data ?? [];
  const canDefine = !!profile?.is_admin || departments.some((m) => m.department_id === departmentId && m.is_car_admin);
  const topicsQuery = useGuideTopicsQuery(canDefine ? departmentId : undefined);
  const upsert = useUpsertGuideTopicMutation();
  const move = useMoveGuideTopicMutation();
  const remove = useDeleteGuideTopicMutation();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [toRemove, setToRemove] = useState<GuideTopic | null>(null);
  const topics = topicsQuery.data ?? [];

  if (!canDefine) {
    return (
      <div className="mx-auto max-w-2xl p-4">
        <EmptyState icon={BookOpen} message={he.carGuides.topics.notAllowed} />
      </div>
    );
  }

  async function save() {
    if (!draft) return;
    try {
      await upsert.mutateAsync({ departmentId, topicId: draft.topicId, title: draft.title.trim(), required: draft.required, active: draft.active });
      toast.success(he.carGuides.topics.saved);
      setDraft(null);
    } catch {
      // toasted by the mutation
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 pb-24" data-testid="guide-topics">
      <PageHeader
        title={he.carGuides.topics.title}
        actions={
          <Button size="sm" onClick={() => setDraft(NEW_DRAFT)} data-testid="guide-topic-add">
            <Plus className="me-1 size-4" aria-hidden="true" />
            {he.carGuides.topics.add}
          </Button>
        }
      />
      <p className="text-sm text-muted-foreground">{he.carGuides.topics.help}</p>
      {topicsQuery.isLoading ? (
        <CardListSkeleton count={3} />
      ) : topics.length === 0 ? (
        <EmptyState icon={BookOpen} message={he.carGuides.topics.empty} />
      ) : (
        <div className="space-y-2">
          {topics.map((topic, index) => (
            <Card key={topic.id} className="bg-gradient-card shadow-card" data-testid="guide-topic">
              <CardContent className="flex items-center justify-between gap-2 p-3 text-sm">
                <div className="space-y-1">
                  <p className="font-medium" dir="auto">{topic.title}</p>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="outline">{topic.required ? he.carGuides.topics.requiredBadge : he.carGuides.topics.optionalBadge}</Badge>
                    {!topic.active ? <Badge variant="outline">{he.carGuides.topics.inactive}</Badge> : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center">
                  <Button variant="ghost" size="icon" aria-label={he.carGuides.topics.moveUp} disabled={index === 0 || move.isPending} onClick={() => move.mutate({ topicId: topic.id, direction: -1 })}>
                    <ArrowUp className="size-4" aria-hidden="true" />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label={he.carGuides.topics.moveDown} disabled={index === topics.length - 1 || move.isPending} onClick={() => move.mutate({ topicId: topic.id, direction: 1 })}>
                    <ArrowDown className="size-4" aria-hidden="true" />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label={he.carGuides.topics.edit} data-testid="guide-topic-edit"
                    onClick={() => setDraft({ topicId: topic.id, title: topic.title, required: topic.required, active: topic.active })}>
                    <Pencil className="size-4" aria-hidden="true" />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label={he.carGuides.topics.remove} onClick={() => setToRemove(topic)}>
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
        title={draft?.topicId ? he.carGuides.topics.edit : he.carGuides.topics.add}
        submitLabel={he.carGuides.topics.save}
        submitDisabled={!draft || draft.title.trim() === ""}
        loading={upsert.isPending}
        onSubmit={() => void save()}
      >
        {draft ? (
          <div className="space-y-3">
            <label className="grid gap-2 text-sm">
              {he.carGuides.topics.label}
              <Input value={draft.title} maxLength={120} placeholder={he.carGuides.topics.labelPlaceholder}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })} data-testid="guide-topic-title" />
            </label>
            <div className="flex items-center justify-between text-sm">
              <Label htmlFor="guide-topic-required">{he.carGuides.topics.required}</Label>
              <Switch id="guide-topic-required" checked={draft.required} onCheckedChange={(checked) => setDraft({ ...draft, required: checked })} />
            </div>
            <div className="flex items-center justify-between text-sm">
              <Label htmlFor="guide-topic-active">{he.carGuides.topics.active}</Label>
              <Switch id="guide-topic-active" checked={draft.active} onCheckedChange={(checked) => setDraft({ ...draft, active: checked })} />
            </div>
          </div>
        ) : null}
      </FormDialog>

      <ConfirmDialog
        open={toRemove !== null}
        onOpenChange={(next) => !next && setToRemove(null)}
        title={he.carGuides.topics.removeTitle}
        description={he.carGuides.topics.removeBody}
        confirmLabel={he.carGuides.topics.remove}
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (!toRemove) return;
          remove.mutate(toRemove.id, { onSuccess: () => { toast.success(he.carGuides.topics.removed); setToRemove(null); } });
        }}
      />
    </div>
  );
}
