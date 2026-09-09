import { MessageSquare } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { he } from "@/i18n/he";
import { showErrorToast } from "@/lib/rpc";

import { NOTIFICATION_PLACEHOLDERS, renderSample } from "../lib/placeholders";
import { useNotificationTemplates, useUpdateNotificationTemplateMutation } from "../hooks";
import type { NotificationTemplate } from "../api";

const CHANNEL_LABEL: Record<NotificationTemplate["channel"], string> = {
  push: he.adminTemplates.channelPush,
  inbox: he.adminTemplates.channelInbox,
  whatsapp: he.adminTemplates.channelWhatsapp,
  email: he.adminTemplates.channelEmail,
};

function TemplateEditor({ template, onSaved }: { template: NotificationTemplate; onSaved: () => void }) {
  const updateMutation = useUpdateNotificationTemplateMutation();
  const [title, setTitle] = useState(template.title ?? "");
  const [body, setBody] = useState(template.body);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  function insertPlaceholder(token: string) {
    const el = bodyRef.current;
    const insert = `{{${token}}}`;
    if (!el) {
      setBody((b) => b + insert);
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = body.slice(0, start) + insert + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + insert.length, start + insert.length);
    });
  }

  async function save() {
    try {
      await updateMutation.mutateAsync({ id: template.id, patch: { title: title || null, body } });
      toast.success(he.adminCommon.savedToast);
      onSaved();
    } catch (error) {
      showErrorToast(error);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {template.title !== null ? (
        <label className="flex flex-col gap-1 text-sm">
          {he.adminTemplates.fieldTitle}
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      ) : null}
      <label className="flex flex-col gap-1 text-sm">
        {he.adminTemplates.fieldBody}
        <Textarea ref={bodyRef} rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>

      <div>
        <p className="mb-1 text-xs text-muted-foreground">{he.adminTemplates.placeholdersLabel}</p>
        <div className="flex flex-wrap gap-1">
          {NOTIFICATION_PLACEHOLDERS.map((token) => (
            <button
              key={token}
              type="button"
              className="rounded-full border px-2 py-0.5 text-xs hover:bg-accent"
              onClick={() => insertPlaceholder(token)}
            >
              {"{{"}
              {token}
              {"}}"}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-md border bg-muted/30 p-3">
        <p className="mb-1 text-xs text-muted-foreground">{he.adminTemplates.previewLabel}</p>
        {title ? <p className="font-medium">{renderSample(title)}</p> : null}
        <p className="whitespace-pre-wrap text-sm">{renderSample(body)}</p>
      </div>

      <Button onClick={save}>{he.adminCommon.save}</Button>
    </div>
  );
}

export function TemplatesScreen() {
  const templatesQuery = useNotificationTemplates();
  const [editing, setEditing] = useState<NotificationTemplate | null>(null);
  const templates = templatesQuery.data ?? [];

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4">
      <PageHeader title={he.screen.admin.templates} subtitle={he.adminTemplates.subtitle} />

      {templates.length === 0 ? (
        <EmptyState icon={MessageSquare} message={he.adminTemplates.empty} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{he.adminTemplates.columnEvent}</TableHead>
              <TableHead>{he.adminTemplates.columnChannel}</TableHead>
              <TableHead>{he.adminTemplates.columnVariant}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {templates.map((t) => (
              <TableRow key={t.id} className="cursor-pointer" onClick={() => setEditing(t)}>
                <TableCell>{he.notif[t.event]}</TableCell>
                <TableCell>
                  <Badge variant="outline">{CHANNEL_LABEL[t.channel]}</Badge>
                </TableCell>
                <TableCell dir="ltr">{t.variant ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Sheet open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{editing ? he.notif[editing.event] : ""}</SheetTitle>
          </SheetHeader>
          <div className="mt-4">{editing ? <TemplateEditor template={editing} onSaved={() => setEditing(null)} /> : null}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
