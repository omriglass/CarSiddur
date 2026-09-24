// Extracted from `RequestForm.tsx` (docs/TODO.md "Code review 2026-09-24" R9):
// the companions/children/guest-passengers field group. Pure move —
// behaviour and markup unchanged.
import { Controller, type Control } from "react-hook-form";

import { FormItem } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CompanionPicker } from "@/components/CompanionPicker";
import { t, tv } from "@/i18n/he";

import type { RequestFormValues } from "../../schema";
import { FieldError } from "./FieldError";

export interface PassengersFieldsProps {
  control: Control<RequestFormValues>;
  members: { id: string; name: string }[];
  children: { id: string; name: string; age: number | null }[];
  namedAdultCount: number;
  namedChildCount: number;
  guestNamesError: string | undefined;
}

export function PassengersFields({ control, members, children, namedAdultCount, namedChildCount, guestNamesError }: PassengersFieldsProps) {
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

      <FormItem data-field="children">
        <Label>{t("field.children")}</Label>
        <Controller control={control} name="children" render={({ field }) => (
          <CompanionPicker
            members={children.map((child) => ({
              ...child,
              name: child.age == null ? child.name : `${child.name} · ${child.age}`,
            }))}
            value={field.value}
            onChange={field.onChange}
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
