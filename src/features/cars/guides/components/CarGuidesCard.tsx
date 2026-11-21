import { BookOpen, Pencil } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { paths } from "@/app/routes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { he, tv } from "@/i18n/he";

import type { CarGuide, GuideTopic } from "../api";
import { useCarGuidesQuery, useGuideTopicsQuery } from "../hooks";
import { guideRows, missingRequired } from "../lib/guides";

import { CarGuidesDialog } from "./CarGuidesBody";
import { GuideEditorDialog } from "./GuideEditorDialog";

/**
 * REQ item 259 on the car page ("לכל מי שנוסע/ת ברכב"): the car's guides — a tap opens the step viewer. Whoever
 * manages the car (`can_manage_car`) also sees the department topics not written yet ("כתיבה"), a pencil per guide,
 * "+ מדריך", and on a shared car the prompt "לא הוזן מדריך: …" for the required ones; car admins / admins get the link
 * to the topics. Nothing to show to a reader of a car without guides.
 */
export function CarGuidesCard({ car, canManage, canDefine }: {
  car: { id: string; department_id: string; type: string };
  canManage: boolean;
  canDefine: boolean;
}) {
  const guidesQuery = useCarGuidesQuery(car.id);
  const topicsQuery = useGuideTopicsQuery(car.department_id);
  const [reading, setReading] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ guide: CarGuide | null; topic: GuideTopic | null } | null>(null);
  const rows = guideRows(topicsQuery.data ?? [], guidesQuery.data ?? []);
  const missing = car.type === "shared" ? missingRequired(rows) : [];
  const visible = canManage ? rows : rows.filter((row) => row.kind === "guide");
  if (!canManage && !canDefine && visible.length === 0) return null;

  return (
    <Card className="bg-gradient-card shadow-card" data-testid="car-guides-card">
      <CardContent className="space-y-2 p-3 text-sm">
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <BookOpen className="size-5" aria-hidden="true" />
          </span>
          <p className="font-medium">{he.carGuides.cardTitle}</p>
        </div>
        {canManage && missing.length ? (
          <p className="rounded-md bg-primary/10 p-2 font-medium text-primary" data-testid="car-guides-missing">
            {tv("carGuides.missing", { topics: missing.map((t) => t.title).join(", ") })}
          </p>
        ) : null}
        {visible.length === 0 ? <p className="text-muted-foreground">{he.carGuides.empty}</p> : null}
        <ul className="divide-y">
          {visible.map((row) => row.kind === "guide" ? (
            <li key={row.guide.id} className="flex items-center gap-2 py-1.5" data-testid="car-guide-row">
              <button type="button" className="min-w-0 flex-1 text-start" onClick={() => setReading(row.guide.id)}>
                <span className="block font-medium text-primary underline-offset-2 hover:underline" dir="auto">{row.guide.title}</span>
                <span className="block text-xs text-muted-foreground">{tv("carGuides.editor.copyStepCount", { count: String(row.guide.steps.length) })}</span>
              </button>
              {canManage ? (
                <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={he.carGuides.editor.edit}
                  onClick={() => setEditing({ guide: row.guide, topic: row.topic })} data-testid="car-guide-edit">
                  <Pencil className="size-4" aria-hidden="true" />
                </Button>
              ) : null}
            </li>
          ) : (
            <li key={`missing-${row.topic.id}`} className="flex items-center gap-2 py-1.5" data-testid="car-guide-missing-row">
              <span className="min-w-0 flex-1">
                <span className="block" dir="auto">{row.topic.title}</span>
                <span className="block text-xs text-muted-foreground">{he.carGuides.notWritten}</span>
              </span>
              {row.topic.required ? <Badge variant="outline">{he.carGuides.topics.requiredBadge}</Badge> : null}
              <Button type="button" variant="outline" size="sm" onClick={() => setEditing({ guide: null, topic: row.topic })} data-testid="car-guide-write">
                {he.carGuides.write}
              </Button>
            </li>
          ))}
        </ul>
        {canManage || canDefine ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            {canManage ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setEditing({ guide: null, topic: null })} data-testid="car-guide-add">
                {he.carGuides.editor.add}
              </Button>
            ) : <span />}
            {canDefine ? (
              <Button asChild variant="link" size="sm">
                <Link to={paths.carGuideTopics(car.department_id)} data-testid="car-guide-topics-link">{he.carGuides.topics.link}</Link>
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardContent>
      <CarGuidesDialog carId={car.id} open={reading !== null} onOpenChange={(open) => !open && setReading(null)} initialGuideId={reading} />
      {editing ? (
        <GuideEditorDialog
          key={editing.guide?.id ?? editing.topic?.id ?? "new"}
          car={car}
          guide={editing.guide}
          topic={editing.topic}
          open
          onOpenChange={(open) => !open && setEditing(null)}
        />
      ) : null}
    </Card>
  );
}
