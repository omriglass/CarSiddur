import { zodResolver } from "@hookform/resolvers/zod";
import { useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useScrollToFirstError } from "@/components/useScrollToFirstError";
import { Checkbox } from "@/components/ui/checkbox";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { he } from "@/i18n/he";
import { showErrorToast } from "@/lib/rpc";

import { useReplaceSeatConfigsMutation, useSeatConfigs, useUpdateCarMutation, useCreateCarMutation } from "../hooks";
import { CAR_FEATURES, carSchema, type CarFormValues } from "../schema";
import { SeatConfigEditor } from "./SeatConfigEditor";
import type { Car } from "../api";

import type { Passengers } from "@/solver";

export const FEATURE_LABEL: Record<(typeof CAR_FEATURES)[number], string> = {
  roof_rack: he.adminCars.featureRoofRack,
  large_trunk: he.adminCars.featureLargeTrunk,
  automatic: he.adminCars.featureAutomatic,
  awd: he.adminCars.featureAwd,
};

export interface ResponsibleOption {
  id: string;
  name: string;
}

interface CarFormProps {
  /** `null` only in the admin "new car" sheet. */
  car: Car | null;
  onSaved: () => void;
  /** Admin's fleet screen (`/admin/cars`) picks a department per car; the car page (`/cars/:carId`) never reassigns a car's department, so it hides this field entirely and shows the department elsewhere (`CarManageScreen`'s header). Defaults `true` (the admin screen's prior, only behavior). */
  showDepartmentField?: boolean;
  departments?: { id: string; name: string }[];
  /**
   * Whether the current viewer may reassign `responsible_id` (admins only,
   * REQUIREMENTS §6.6/§13.71 — "car admin" = regular admin for now). When
   * `false` the field renders read-only (car page, non-admin responsible
   * person). Defaults `true` (the admin screen, always admin).
   */
  canEditResponsible?: boolean;
  /** Department members eligible to become `responsible_id`; only needed (and fetched by the caller) when `canEditResponsible`. */
  responsibleOptions?: ResponsibleOption[];
  /**
   * Whether to render the seat-capacity matrix editor. RLS has no grant for
   * a non-admin `is_car_responsible` write on `car_seat_configs`
   * (DATA_MODEL.md §4.3) — only admins may edit it, regardless of screen.
   * Defaults `true` (the admin screen, always admin).
   */
  canEditSeatConfigs?: boolean;
}

export function CarForm({
  car,
  onSaved,
  showDepartmentField = true,
  departments = [],
  canEditResponsible = true,
  responsibleOptions = [],
  canEditSeatConfigs = true,
}: CarFormProps) {
  const createMutation = useCreateCarMutation();
  const updateMutation = useUpdateCarMutation();
  const seatConfigsQuery = useSeatConfigs(car?.id);
  const replaceSeatConfigsMutation = useReplaceSeatConfigsMutation();
  const [pendingSeatConfigs, setPendingSeatConfigs] = useState<Passengers[] | null>(null);

  const form = useForm<CarFormValues>({
    resolver: zodResolver(carSchema),
    defaultValues: {
      name: car?.name ?? "",
      license_plate: car?.license_plate ?? "",
      access_code: car?.access_code ?? "",
      is_replaced: car?.is_replaced ?? false,
      replacement_code: car?.replacement_code ?? null,
      department_id: car?.department_id ?? "",
      status: car?.status ?? "active",
      features: car?.features ?? [],
      notes: car?.notes ?? null,
      built_in_child_seats: car?.built_in_child_seats ?? 0,
      built_in_boosters: car?.built_in_boosters ?? 0,
      responsible_id: car?.responsible_id ?? null,
    },
  });
  const formRef = useRef<HTMLFormElement>(null);
  const onInvalid = useScrollToFirstError(form, formRef);
  const isReplaced = useWatch({ control: form.control, name: "is_replaced" });

  async function onSubmit(values: CarFormValues) {
    try {
      const payload = { ...values, replacement_code: values.is_replaced ? values.replacement_code : null };
      let carId = car?.id;
      if (car) {
        await updateMutation.mutateAsync({ id: car.id, patch: payload });
      } else {
        const created = await createMutation.mutateAsync(payload);
        carId = created.id;
      }
      if (canEditSeatConfigs && carId && pendingSeatConfigs) {
        await replaceSeatConfigsMutation.mutateAsync({ carId, configs: pendingSeatConfigs });
      }
      toast.success(he.adminCommon.savedToast);
      onSaved();
    } catch (error) {
      showErrorToast(error);
    }
  }

  return (
    <Form {...form}>
      <form ref={formRef} className="flex flex-col gap-4" onSubmit={form.handleSubmit(onSubmit, onInvalid)}>
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{he.adminCars.fieldName}</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="license_plate"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{he.adminCars.fieldPlate}</FormLabel>
              <FormControl>
                <Input {...field} dir="ltr" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="access_code"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{he.adminCars.fieldAccessCode}</FormLabel>
              <FormControl>
                <Input {...field} type="text" inputMode="numeric" dir="ltr" maxLength={5} autoComplete="off" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="is_replaced"
          render={({ field }) => (
            <FormItem className="flex items-center gap-2 space-y-0">
              <FormControl>
                <Checkbox
                  checked={field.value}
                  onCheckedChange={(checked) => {
                    field.onChange(checked === true);
                    if (checked !== true) {
                      form.setValue("replacement_code", null, { shouldDirty: true });
                      form.clearErrors("replacement_code");
                    }
                  }}
                />
              </FormControl>
              <FormLabel>{he.adminCars.fieldIsReplaced}</FormLabel>
            </FormItem>
          )}
        />
        {isReplaced ? (
          <FormField
            control={form.control}
            name="replacement_code"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{he.adminCars.fieldReplacementCode}</FormLabel>
                <FormControl>
                  <Input {...field} value={field.value ?? ""} type="text" inputMode="numeric" dir="ltr" maxLength={5} autoComplete="off" />
                </FormControl>
                <FormDescription>{he.adminCars.replacementCodeHelp}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        ) : null}
        {showDepartmentField ? (
          <FormField
            control={form.control}
            name="department_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{he.adminCars.fieldDepartment}</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {departments.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        ) : null}
        {showDepartmentField && car?.type === "temporary" ? (
          // Shown only on the admin fleet screen (`showDepartmentField`), not on the
          // owner's own car page (`CarManageScreen`) where the note would be redundant.
          <p className="text-sm text-muted-foreground">{he.adminCars.temporaryOwnedNote}</p>
        ) : null}
        <FormField
          control={form.control}
          name="status"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{he.adminCars.fieldStatus}</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="active">{he.car.status.active}</SelectItem>
                  <SelectItem value="maintenance">{he.car.status.maintenance}</SelectItem>
                  <SelectItem value="retired">{he.car.status.retired}</SelectItem>
                </SelectContent>
              </Select>
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="responsible_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{he.adminCars.fieldResponsible}</FormLabel>
              {canEditResponsible ? (
                <>
                  <Select
                    value={field.value ?? ""}
                    onValueChange={(value) => field.onChange(value === "" ? null : value)}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="">{he.adminCars.fieldResponsibleNone}</SelectItem>
                      {responsibleOptions.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </>
              ) : (
                <>
                  <p className="text-sm text-foreground">
                    {responsibleOptions.find((option) => option.id === field.value)?.name ?? he.adminCars.fieldResponsibleNone}
                  </p>
                  <FormDescription>{he.carPage.fieldResponsibleReadonlyHelp}</FormDescription>
                </>
              )}
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="features"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{he.adminCars.fieldFeatures}</FormLabel>
              <div className="flex flex-wrap gap-3">
                {CAR_FEATURES.map((feature) => (
                  <label key={feature} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={field.value.includes(feature)}
                      onCheckedChange={(checked) =>
                        field.onChange(
                          checked ? [...field.value, feature] : field.value.filter((f: string) => f !== feature),
                        )
                      }
                    />
                    {FEATURE_LABEL[feature]}
                  </label>
                ))}
              </div>
            </FormItem>
          )}
        />
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="built_in_child_seats"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{he.adminCars.fieldBuiltInChildSeats}</FormLabel>
                <FormControl>
                  <Input type="number" min={0} value={field.value} onChange={(e) => field.onChange(Number(e.target.value))} />
                </FormControl>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="built_in_boosters"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{he.adminCars.fieldBuiltInBoosters}</FormLabel>
                <FormControl>
                  <Input type="number" min={0} value={field.value} onChange={(e) => field.onChange(Number(e.target.value))} />
                </FormControl>
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="notes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{he.adminCars.fieldNotes}</FormLabel>
              <FormControl>
                <Textarea {...field} value={field.value ?? ""} />
              </FormControl>
            </FormItem>
          )}
        />

        {canEditSeatConfigs ? (
          <div className="border-t pt-4">
            <SeatConfigEditor
              key={car?.id ?? "new"}
              initial={
                (seatConfigsQuery.data ?? []).map((sc) => ({ adults: sc.adults, childSeats: sc.child_seats, boosters: sc.boosters }))
              }
              onChange={setPendingSeatConfigs}
            />
          </div>
        ) : null}

        <Button type="submit" disabled={form.formState.isSubmitting}>
          {he.adminCommon.save}
        </Button>
      </form>
    </Form>
  );
}
