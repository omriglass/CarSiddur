// Extracted from `RequestForm.tsx` (docs/TODO.md "Code review 2026-09-24" R9):
// the companions/children/guest-passengers field group. Pure move —
// behaviour and markup unchanged.
import { Controller, type Control } from "react-hook-form";

import { FormItem } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CompanionPicker } from "@/components/CompanionPicker";
import { he, t, tv } from "@/i18n/he";

import type { RequestFormValues } from "../../schema";
import { AdultsStepper } from "./AdultsStepper";
import { FieldError } from "./FieldError";
import { UnnamedChildrenSteppers } from "./UnnamedChildrenSteppers";

export interface PassengersFieldsProps {
  control: Control<RequestFormValues>;
  /** R9U7: called when a named child was just added (suggests the childcare ride type). */
  onChildAdded?: () => void;
  members: { id: string; name: string }[];
  children: { id: string; name: string; age: number | null }[];
  namedAdultCount: number;
  namedChildCount: number;
  guestNamesError: string | undefined;
}

export function PassengersFields({ control, onChildAdded, members, children, namedAdultCount, namedChildCount, guestNamesError }: PassengersFieldsProps) {
  return (
    <>
      <FormItem data-field="companions">
        <Label>{t("field.companions")}</Label>
        <Controller
          control={control}
          name="companions"
          render={({ field }) => (
            <CompanionPicker
              members={members.map((m) => ({ id: m.id, name: m.name }))}
              value={field.value}
              onChange={field.onChange}
            />
          )}
        />
        <p className="text-sm text-muted-foreground">{tv("request.namedPassengerCount", { count: String(namedAdultCount) })}</p>
      </FormItem>

      <FormItem data-field="extraAdults">
        <Label>{he.request.extraAdultsLabel}</Label>
        <Controller
          control={control}
          name="extraAdults"
          render={({ field }) => (
            <AdultsStepper value={field.value ?? 0} onChange={field.onChange} moreLabel={he.request.extraAdultsMore} lessLabel={he.request.extraAdultsLess} testId="classic-extra-adults" />
          )}
        />
      </FormItem>

      <FormItem data-field="legacyChildSeats">
        <Controller
          control={control}
          name="legacyChildSeats"
          render={({ field: seatsField }) => (
            <Controller
              control={control}
              name="boosters"
              render={({ field: boostersField }) => (
                <UnnamedChildrenSteppers
                  childSeats={seatsField.value ?? 0}
                  boosters={boostersField.value ?? 0}
                  onChildSeatsChange={seatsField.onChange}
                  onBoostersChange={boostersField.onChange}
                  testId="classic-unnamed-children"
                />
              )}
            />
          )}
        />
      </FormItem>

      <FormItem data-field="children">
        <Label>{t("field.children")}</Label>
        <Controller control={control} name="children" render={({ field }) => (
          <CompanionPicker
            members={children.map((child) => ({
              ...child,
              name: child.age == null ? child.name : `${child.name} · ${child.age}`,
            }))}
            value={field.value}
            onChange={(next) => {
              const added = next.some((id) => !field.value.includes(id));
              field.onChange(next);
              if (added) onChildAdded?.();
            }}
            label={t("field.children")}
          />
        )} />
        <p className="text-sm text-muted-foreground">{tv("request.namedChildCount", { count: String(namedChildCount) })}</p>
      </FormItem>

      <FormItem data-field="guestNames">
        <Label htmlFor="request-guest-names">{t("quickRequest.guestPassengers")}</Label>
        <Controller control={control} name="guestNames" render={({ field }) => (
          <Textarea id="request-guest-names" value={field.value} onChange={field.onChange} rows={2} />
        )} />
        <p className="text-xs text-muted-foreground">{t("quickRequest.guestPassengersHelp")}</p>
        <FieldError message={guestNamesError} />
      </FormItem>
    </>
  );
}
