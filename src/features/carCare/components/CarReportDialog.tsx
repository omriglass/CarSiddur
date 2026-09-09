import { zodResolver } from "@hookform/resolvers/zod";
import { AlertTriangle, Droplets, Gauge, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import { PortalDialogContent } from "@/components/PortalDialogContent";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { he, tv } from "@/i18n/he";

import { useLogCarCareMutation, useReportCarIssueMutation } from "../hooks";
import {
  CAR_ISSUE_CATEGORIES,
  carIssueReportSchema,
  DEFAULT_TIRE_STATES,
  type CarIssueReportValues,
} from "../schema";
import { TireFillPanel } from "./TireFillPanel";

type View = "home" | "problem" | "tires" | "wash" | "tiresDone" | "washDone";

/** How long the wash/tire-fill celebration shows before the dialog auto-closes. */
const CELEBRATION_MS = 1800;

export interface CarReportDialogProps {
  carId: string;
  carName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * "דיווח על רכב &lt;name&gt;" (REQUIREMENTS §6.6, UX_FLOWS §3.9): report a
 * problem, log a tire fill, or log a wash — opened from any car's name via
 * `CarNameWithReport`. Built on `PortalDialogContent` (none of its own
 * fields need a picker portal today, but the dialog-hosting convention is
 * "use it unless proven unnecessary", CLAUDE.md Conventions).
 */
export function CarReportDialog({ carId, carName, open, onOpenChange }: CarReportDialogProps) {
  const [view, setView] = useState<View>("home");
  const [tires, setTires] = useState(DEFAULT_TIRE_STATES);
  const [tireNote, setTireNote] = useState("");

  const reportIssueMutation = useReportCarIssueMutation();
  const logCarCareMutation = useLogCarCareMutation();

  const form = useForm<CarIssueReportValues>({
    resolver: zodResolver(carIssueReportSchema),
    defaultValues: { category: undefined, description: "" },
  });

  /** Resets every sub-view's local state so the next open starts fresh at `home`. */
  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setView("home");
      setTires(DEFAULT_TIRE_STATES);
      setTireNote("");
      form.reset({ category: undefined, description: "" });
    }
  }

  useEffect(() => {
    if (view !== "tiresDone" && view !== "washDone") return undefined;
    const timer = setTimeout(() => handleOpenChange(false), CELEBRATION_MS);
    return () => clearTimeout(timer);
    // `handleOpenChange` is stable enough here (closes over props that don't change while this
    // celebration view is showing); re-running the effect on every render would restart the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  async function submitProblem(values: CarIssueReportValues) {
    if (!values.category) return; // guaranteed by carIssueReportSchema's superRefine
    try {
      await reportIssueMutation.mutateAsync({ carId, category: values.category, description: values.description });
      toast.success(he.carCare.problemSuccessToast);
      handleOpenChange(false);
    } catch {
      // already toasted by useReportCarIssueMutation's onError
    }
  }

  async function submitTires() {
    try {
      await logCarCareMutation.mutateAsync({ carId, kind: "tire_fill", tires, note: tireNote.trim() || undefined });
      setView("tiresDone");
    } catch {
      // already toasted by useLogCarCareMutation's onError
    }
  }

  async function submitWash() {
    try {
      await logCarCareMutation.mutateAsync({ carId, kind: "wash" });
      setView("washDone");
    } catch {
      // already toasted by useLogCarCareMutation's onError
    }
  }

  const title = tv("carCare.dialogTitle", { car: carName });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <PortalDialogContent className="max-w-md">
        <DialogClose asChild>
          <button
            type="button"
            aria-label={he.carCare.close}
            data-testid="car-report-close"
            className="absolute start-3 top-3 flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground transition-smooth hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </DialogClose>
        <DialogHeader className="ps-9 pe-9">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        {view === "home" ? (
          <div className="grid gap-3">
            <button
              type="button"
              onClick={() => setView("problem")}
              className="flex min-h-16 items-center gap-3 rounded-lg border p-4 text-start transition-smooth hover:bg-accent/40"
            >
              <AlertTriangle className="size-6 shrink-0 text-destructive" aria-hidden="true" />
              <span className="font-medium">{he.carCare.homeProblemTitle}</span>
            </button>
            <button
              type="button"
              onClick={() => setView("tires")}
              className="flex min-h-16 items-center gap-3 rounded-lg border p-4 text-start transition-smooth hover:bg-accent/40"
            >
              <Gauge className="size-6 shrink-0 text-maintenance" aria-hidden="true" />
              <span className="font-medium">{he.carCare.homeTireFillTitle}</span>
            </button>
            <button
              type="button"
              onClick={() => setView("wash")}
              className="flex min-h-16 items-center gap-3 rounded-lg border p-4 text-start transition-smooth hover:bg-accent/40"
            >
              <Droplets className="size-6 shrink-0 text-booked" aria-hidden="true" />
              <span className="font-medium">{he.carCare.homeWashTitle}</span>
            </button>
          </div>
        ) : null}

        {view === "problem" ? (
          <Form {...form}>
            <form className="flex flex-col gap-4" onSubmit={form.handleSubmit(submitProblem)}>
              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{he.carCare.categoryLabel}</FormLabel>
                    <FormControl>
                      <RadioGroup value={field.value ?? ""} onValueChange={field.onChange} className="gap-2">
                        {CAR_ISSUE_CATEGORIES.map((category) => (
                          <label key={category} className="flex min-h-11 items-center gap-2 rounded-md border p-2 text-sm">
                            <RadioGroupItem value={category} />
                            {he.carCare.category[category]}
                          </label>
                        ))}
                      </RadioGroup>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{he.carCare.descriptionLabel}</FormLabel>
                    <FormControl>
                      <Textarea placeholder={he.carCare.descriptionPlaceholder} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setView("home")}>
                  {he.common.back}
                </Button>
                <Button type="submit" disabled={form.formState.isSubmitting}>
                  {he.carCare.submitProblem}
                </Button>
              </div>
            </form>
          </Form>
        ) : null}

        {view === "tires" ? (
          <div className="flex flex-col gap-4">
            <TireFillPanel value={tires} onChange={setTires} note={tireNote} onNoteChange={setTireNote} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setView("home")}>
                {he.common.back}
              </Button>
              <Button type="button" disabled={logCarCareMutation.isPending} onClick={submitTires}>
                {he.carCare.tireDone}
              </Button>
            </div>
          </div>
        ) : null}

        {view === "wash" ? (
          <div className="flex flex-col gap-4">
            <Button
              type="button"
              size="lg"
              className="min-h-16 text-base"
              disabled={logCarCareMutation.isPending}
              onClick={submitWash}
            >
              <Droplets className="me-2 size-5" aria-hidden="true" />
              {he.carCare.washButton}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setView("home")}>
              {he.common.back}
            </Button>
          </div>
        ) : null}

        {view === "tiresDone" ? <CelebrationMessage message={he.carCare.tireCelebration} /> : null}
        {view === "washDone" ? <CelebrationMessage message={he.carCare.washCelebration} /> : null}
      </PortalDialogContent>
    </Dialog>
  );
}

/**
 * CSS-only celebration (`motion-safe:`/`motion-reduce:` Tailwind variants —
 * `prefers-reduced-motion` respected without any JS `matchMedia` check;
 * keyframes in `tailwind.config.ts`).
 */
function CelebrationMessage({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <span className="relative text-4xl motion-safe:animate-car-care-bounce motion-reduce:animate-none" aria-hidden="true">
        🎉
        <span className="absolute -start-6 -top-2 motion-safe:animate-car-care-pop motion-reduce:animate-none [animation-delay:0.1s]">✨</span>
        <span className="absolute -end-6 top-0 motion-safe:animate-car-care-pop motion-reduce:animate-none [animation-delay:0.3s]">✨</span>
        <span className="absolute start-1/2 -top-6 motion-safe:animate-car-care-pop motion-reduce:animate-none [animation-delay:0.5s]">✨</span>
      </span>
      <p className="text-lg font-semibold">{message}</p>
    </div>
  );
}
