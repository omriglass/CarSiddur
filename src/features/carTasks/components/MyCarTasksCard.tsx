import { ClipboardList } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CarReportDialog } from "@/features/carCare/components/CarReportDialog";
import { he, tv } from "@/i18n/he";

import { useCompleteCarTaskMutation, useMyCarTasksQuery } from "../hooks";
import { groupTasksByCar, visibleTasks } from "../lib/window";

import type { MyCarTask } from "../api";

const CLOCK_MS = 30_000;

type FormView = "tires" | "wash" | "km";

interface MyCarTasksCardProps {
  /** The ride sheet passes its ride: only that ride's tasks show. On /my (no ride) every visible task shows once. */
  rideId?: string;
}

/**
 * Tasks the car's managers asked of whoever uses the car next (REQ item 150 b) — only inside the person's window
 * (15 minutes before the ride … 15 minutes after it); the server decides (`my_car_tasks()`), the clock here only
 * lets a card go away when its window ends between two refetches. Never rendered on the board or the siddur grid.
 */
export function MyCarTasksCard({ rideId }: MyCarTasksCardProps) {
  const query = useMyCarTasksQuery();
  const complete = useCompleteCarTaskMutation();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [form, setForm] = useState<{ task: MyCarTask; view: FormView } | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const tasks = visibleTasks(query.data ?? [], nowMs, rideId);
  if (tasks.length === 0) return null;

  async function markDone(task: MyCarTask) {
    try {
      await complete.mutateAsync(task.task_id);
      toast.success(he.carTasks.doneToast);
    } catch {
      // already toasted by useCompleteCarTaskMutation's onError
    }
  }

  return (
    <>
      {groupTasksByCar(tasks).map((group) => (
        <Card key={group[0]?.car_id} className="border-primary/40 bg-gradient-card shadow-card" data-testid="my-car-tasks">
          <CardContent className="space-y-3 p-3 text-sm">
            <div className="flex items-center gap-2 font-medium">
              <ClipboardList className="size-5 text-primary" aria-hidden="true" />
              {tv("carTasks.cardTitle", { car: group[0]?.car_name ?? "" })}
            </div>
            <ul className="space-y-2">
              {group.map((task) => (
                <li key={task.task_id} className="flex items-center justify-between gap-3" data-testid="my-car-task">
                  <div>
                    <p>{task.kind === "other" ? task.note : he.carTasks.kind[task.kind]}</p>
                    <p className="text-xs text-muted-foreground">{tv("carTasks.requestedBy", { name: task.requested_by_name })}</p>
                  </div>
                  {task.kind === "other" ? (
                    <Button size="sm" onClick={() => void markDone(task)} disabled={complete.isPending} data-testid="car-task-done">
                      {he.carTasks.actionDone}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid={`car-task-open-${task.kind}`}
                      onClick={() => setForm({ task, view: task.kind === "tire_fill" ? "tires" : task.kind === "wash" ? "wash" : "km" })}
                    >
                      {task.kind === "tire_fill" ? he.carTasks.actionTires : task.kind === "wash" ? he.carTasks.actionWash : he.carTasks.actionKm}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ))}
      {form ? (
        <CarReportDialog
          key={form.task.task_id}
          carId={form.task.car_id}
          carName={form.task.car_name}
          initialView={form.view}
          open
          onOpenChange={(open) => {
            if (!open) setForm(null);
          }}
        />
      ) : null}
    </>
  );
}
