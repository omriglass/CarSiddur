import { zodResolver } from "@hookform/resolvers/zod";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useDepartments } from "@/features/siddur/hooks";
import { he } from "@/i18n/he";
import { showErrorToast } from "@/lib/rpc";

import { useCreateCarMutation, useCarsAdmin, useReplaceSeatConfigsMutation, useSeatConfigs, useUpdateCarMutation } from "../hooks";
import { CAR_FEATURES, carSchema, type CarFormValues } from "../schema";
import { SeatConfigEditor } from "./SeatConfigEditor";
import type { Car } from "../api";

import type { Passengers } from "@/solver";

const FEATURE_LABEL: Record<(typeof CAR_FEATURES)[number], string> = {
  roof_rack: he.adminCars.featureRoofRack,
  large_trunk: he.adminCars.featureLargeTrunk,
  automatic: he.adminCars.featureAutomatic,
  awd: he.adminCars.featureAwd,
};

function CarForm({ car, onSaved }: { car: Car | null; onSaved: () => void }) {
  const departmentsQuery = useDepartments();
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
      department_id: car?.department_id ?? "",
      type: car?.type ?? "shared",
      status: car?.status ?? "active",
      features: car?.features ?? [],
      notes: car?.notes ?? null,
      built_in_child_seats: car?.built_in_child_seats ?? 0,
      built_in_boosters: car?.built_in_boosters ?? 0,
    },
  });

  async function onSubmit(values: CarFormValues) {
    try {
      let carId = car?.id;
      if (car) {
        await updateMutation.mutateAsync({ id: car.id, patch: values });
      } else {
        const created = await createMutation.mutateAsync(values);
        carId = created.id;
      }
      if (carId && pendingSeatConfigs) {
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
      <form className="flex flex-col gap-4" onSubmit={form.handleSubmit(onSubmit)}>
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
                  {(departmentsQuery.data ?? []).map((d) => (
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
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="type"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{he.adminCars.fieldType}</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="shared">{he.car.type.shared}</SelectItem>
                    <SelectItem value="temporary">{he.car.type.temporary}</SelectItem>
                  </SelectContent>
                </Select>
              </FormItem>
            )}
          />
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
        </div>
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

        <div className="border-t pt-4">
          <SeatConfigEditor
            key={car?.id ?? "new"}
            initial={
              (seatConfigsQuery.data ?? []).map((sc) => ({ adults: sc.adults, childSeats: sc.child_seats, boosters: sc.boosters }))
            }
            onChange={setPendingSeatConfigs}
          />
        </div>

        <Button type="submit" disabled={form.formState.isSubmitting}>
          {he.adminCommon.save}
        </Button>
      </form>
    </Form>
  );
}

export function CarsScreen({ initialCarId }: { initialCarId?: string } = {}) {
  const carsQuery = useCarsAdmin();
  const departmentsQuery = useDepartments();
  const [editing, setEditing] = useState<Car | null | undefined>(undefined);
  // Deep-link support for `/admin/cars/:id` (UX_FLOWS §2.1 route table): open
  // that car's editor sheet once its row has loaded, without a fetch effect
  // (state-adjustment-during-render, same pattern as TimeField15's re-sync).
  const [openedInitialFor, setOpenedInitialFor] = useState<string | undefined>(undefined);
  if (initialCarId && initialCarId !== openedInitialFor && carsQuery.data) {
    const match = carsQuery.data.find((c) => c.id === initialCarId);
    if (match) {
      setOpenedInitialFor(initialCarId);
      setEditing(match);
    }
  }

  const departmentsById = new Map((departmentsQuery.data ?? []).map((d) => [d.id, d.name]));
  const cars = carsQuery.data ?? [];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <PageHeader
        title={he.screen.admin.cars}
        subtitle={he.adminCars.subtitle}
        actions={
          <Button onClick={() => setEditing(null)}>
            <Plus className="me-1 size-4" /> {he.adminCars.new}
          </Button>
        }
      />

      {cars.length === 0 ? (
        <EmptyState icon={Plus} message={he.adminCars.empty} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{he.adminCars.fieldName}</TableHead>
              <TableHead>{he.adminCars.fieldPlate}</TableHead>
              <TableHead>{he.adminCars.fieldDepartment}</TableHead>
              <TableHead>{he.adminCars.fieldType}</TableHead>
              <TableHead>{he.adminCars.fieldStatus}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cars.map((car) => (
              <TableRow key={car.id} className="cursor-pointer" onClick={() => setEditing(car)}>
                <TableCell>{car.name}</TableCell>
                <TableCell dir="ltr">{car.license_plate}</TableCell>
                <TableCell>{departmentsById.get(car.department_id) ?? car.department_id}</TableCell>
                <TableCell>{he.car.type[car.type]}</TableCell>
                <TableCell>
                  <Badge variant={car.status === "active" ? "default" : "outline"}>{he.car.status[car.status]}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Sheet open={editing !== undefined} onOpenChange={(open) => !open && setEditing(undefined)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{editing ? he.adminCars.edit : he.adminCars.new}</SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            {editing !== undefined ? <CarForm car={editing} onSaved={() => setEditing(undefined)} /> : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
