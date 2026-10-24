import { ClipboardList } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { FormDialog } from "@/components/FormDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { CAR_TASK_KINDS, type CarTaskKind } from "@/lib/enums";
import { formatTime } from "@/lib/time";

import { useCarTasksQuery, useRequestCarTasksMutation, useWithdrawCarTaskMutation } from "../hooks";

interface CarTasksManagerCardProps {
  car: { id: string; name: string };
}

/** "בקשות מהנוסע/ת הבא/ה" on the car page (managers only, REQ item 150 b): ask, and withdraw what is still open. */
export function CarTasksManagerCard({ car }: CarTasksManagerCardProps) {
  const query = useCarTasksQuery(car.id);
  const requestMutation = useRequestCarTasksMutation();
  const withdrawMutation = useWithdrawCarTaskMutation();
  const [open, setOpen] = useState(false);
  const [kinds, setKinds] = useState<CarTaskKind[]>([]);
  const [note, setNote] = useState("");

  const openTasks = (query.data ?? []).filter((task) => task.status === "open");
  const noteMissing = kinds.includes("other") && note.trim() === "";

  function close(next: boolean) {
    setOpen(next);
    if (!next) {
      setKinds([]);
      setNote("");
    }
  }

  function toggle(kind: CarTaskKind, checked: boolean) {
    setKinds((current) => (checked ? [...current, kind] : current.filter((k) => k !== kind)));
  }

  async function submit() {
    try {
      const created = await requestMutation.mutateAsync({
        carId: car.id,
        kinds,
        note: kinds.includes("other") ? note.trim() : undefined,
      });
      toast.success(created > 0 ? he.carTasks.requestSent : he.carTasks.requestAlreadyOpen);
      close(false);
    } catch {
      // already toasted by useRequestCarTasksMutation's onError
    }
  }

  async function withdraw(taskId: string) {
    try {
      await withdrawMutation.mutateAsync({ taskId, carId: car.id });
      toast.success(he.carTasks.withdrawn);
    } catch {
      // already toasted
    }
  }

  return (
    <>
      <Card className="bg-gradient-card shadow-card" data-testid="car-tasks-manager">
        <CardContent className="space-y-3 p-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 font-medium">
              <ClipboardList className="size-5 text-primary" aria-hidden="true" />
              {he.carTasks.manageTitle}
            </div>
            <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="car-tasks-request">
              {he.carTasks.requestButton}
            </Button>
          </div>
          {openTasks.length === 0 ? (
            <p className="text-xs text-muted-foreground">{query.isLoading ? "" : he.carTasks.openEmpty}</p>
          ) : (
            <ul className="space-y-2">
              {openTasks.map((task) => (
                <li key={task.id} className="flex items-center justify-between gap-3" data-testid="car-task-row">
                  <div>
                    <p>{task.kind === "other" ? task.note : he.carTasks.kind[task.kind]}</p>
                    <p className="text-xs text-muted-foreground">
                      {tv("carTasks.askedBy", {
                        name: task.requested_by_profile?.full_name ?? "",
                        date: `${formatDayDate(task.requested_at)} ${formatTime(new Date(task.requested_at))}`,
                      })}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" disabled={withdrawMutation.isPending} onClick={() => void withdraw(task.id)} data-testid="car-task-withdraw">
                    {he.carTasks.withdraw}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <FormDialog
        open={open}
        onOpenChange={close}
        title={tv("carTasks.requestTitle", { car: car.name })}
        description={he.carTasks.requestHelp}
        submitLabel={he.carTasks.requestSubmit}
        submitDisabled={kinds.length === 0 || noteMissing}
        loading={requestMutation.isPending}
        onSubmit={() => void submit()}
      >
        <div className="grid gap-2">
          {CAR_TASK_KINDS.map((kind) => (
            <label key={kind} className="flex min-h-11 items-center gap-2 rounded-md border p-2 text-sm">
              <Checkbox checked={kinds.includes(kind)} onCheckedChange={(checked) => toggle(kind, checked === true)} data-testid={`car-task-kind-${kind}`} />
              {he.carTasks.kind[kind]}
            </label>
          ))}
        </div>
        {kinds.includes("other") ? (
          <label className="grid gap-2 text-sm">
            {he.carTasks.noteLabel}
            <Textarea
              data-testid="car-task-note"
              value={note}
              maxLength={300}
              placeholder={he.carTasks.notePlaceholder}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
        ) : null}
      </FormDialog>
    </>
  );
}
