import { Route } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { FormDialog } from "@/components/FormDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useSetCarKilometrageMutation } from "@/features/carCare/hooks";
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";

import { formatKm, parseKm } from "../lib/kilometrage";

import type { Car } from "@/features/admin/cars/api";

import type { CarCurrentKm } from "../api";

interface CarKilometrageCardProps {
  car: Pick<Car, "id" | "name">;
  current: CarCurrentKm | null;
  loading?: boolean;
  /** `can_manage_car` (REQ item 150 a): admin, responsible person or (shared car) a car administrator. */
  canCorrect: boolean;
}

/**
 * The car's current kilometrage on `/cars/:carId` (REQ item 150 c). Members add readings from the car report
 * dialog; the car's managers get "תיקון הקילומטראז׳" here — any value, recorded as a correction.
 */
export function CarKilometrageCard({ car, current, loading = false, canCorrect }: CarKilometrageCardProps) {
  const [open, setOpen] = useState(false);
  const [kmText, setKmText] = useState("");
  const [note, setNote] = useState("");
  const mutation = useSetCarKilometrageMutation();
  const km = parseKm(kmText);

  function close(next: boolean) {
    setOpen(next);
    if (!next) {
      setKmText("");
      setNote("");
    }
  }

  async function submit() {
    if (km === null) return;
    try {
      await mutation.mutateAsync({ carId: car.id, km, note: note.trim() || undefined });
      toast.success(he.carPage.kmCorrected);
      close(false);
    } catch {
      // already toasted by useSetCarKilometrageMutation's onError
    }
  }

  return (
    <>
      <Card className="bg-gradient-card shadow-card">
        <CardContent className="flex items-center justify-between gap-3 p-3 text-sm">
          <div className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Route className="size-5" aria-hidden="true" />
            </span>
            <div>
              <p className="text-xs text-muted-foreground">{he.carPage.kmCardTitle}</p>
              <p className="font-medium" dir="ltr" data-testid="car-current-km">
                {loading ? "" : current ? tv("carPage.kmCurrent", { km: formatKm(current.km) }) : he.carPage.kmCurrentNone}
              </p>
              {current ? <p className="text-xs text-muted-foreground">{tv("carPage.kmCurrentAt", { date: formatDayDate(current.recorded_at) })}</p> : null}
            </div>
          </div>
          {canCorrect ? (
            <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="car-km-correct">
              {he.carPage.kmCorrect}
            </Button>
          ) : null}
        </CardContent>
      </Card>
      <FormDialog
        open={open}
        onOpenChange={close}
        title={tv("carPage.kmCorrectTitle", { car: car.name })}
        description={he.carPage.kmCorrectHelp}
        submitLabel={he.carPage.kmCorrectSubmit}
        submitDisabled={km === null}
        loading={mutation.isPending}
        onSubmit={() => void submit()}
      >
        <label className="grid gap-2 text-sm">
          {he.carCare.kmLabel}
          <Input data-testid="car-km-correct-input" type="text" inputMode="numeric" dir="ltr" value={kmText} onChange={(event) => setKmText(event.target.value)} />
        </label>
        <label className="grid gap-2 text-sm">
          {he.carPage.kmCorrectNote}
          <Input value={note} maxLength={300} onChange={(event) => setNote(event.target.value)} />
        </label>
      </FormDialog>
    </>
  );
}
