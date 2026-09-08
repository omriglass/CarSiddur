import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Signpost } from "lucide-react";
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
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { he } from "@/i18n/he";
import { showErrorToast } from "@/lib/rpc";

import { useCreateRideTypeMutation, useRideTypesAdmin, useUpdateRideTypeMutation } from "../hooks";
import { rideTypeSchema, type RideTypeFormValues } from "../schema";
import type { RideType } from "../api";

function RideTypeForm({ rideType, onSaved }: { rideType: RideType | null; onSaved: () => void }) {
  const { departmentId } = useActiveDepartment();
  const createMutation = useCreateRideTypeMutation();
  const updateMutation = useUpdateRideTypeMutation();

  const form = useForm<RideTypeFormValues>({
    resolver: zodResolver(rideTypeSchema),
    defaultValues: {
      name_he: rideType?.name_he ?? "",
      code: rideType?.code ?? "",
      sort_order: rideType?.sort_order ?? 0,
      is_active: rideType?.is_active ?? true,
    },
  });

  async function onSubmit(values: RideTypeFormValues) {
    try {
      if (rideType) {
        await updateMutation.mutateAsync({ id: rideType.id, patch: values });
      } else {
        if (!departmentId) return;
        await createMutation.mutateAsync({ ...values, department_id: departmentId });
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
          name="name_he"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{he.adminRideTypes.fieldNameHe}</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="code"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{he.adminRideTypes.fieldCode}</FormLabel>
              <FormControl>
                <Input {...field} dir="ltr" disabled={!!rideType} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="sort_order"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{he.adminRideTypes.fieldSortOrder}</FormLabel>
              <FormControl>
                <Input type="number" value={field.value} onChange={(e) => field.onChange(Number(e.target.value))} />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="is_active"
          render={({ field }) => (
            <FormItem className="flex flex-row items-center gap-2 space-y-0">
              <FormControl>
                <Checkbox checked={field.value} onCheckedChange={(v) => field.onChange(!!v)} />
              </FormControl>
              <FormLabel className="!mt-0">{he.adminRideTypes.fieldActive}</FormLabel>
            </FormItem>
          )}
        />
        {rideType ? <p className="text-xs text-muted-foreground">{he.adminRideTypes.deactivateConfirm}</p> : null}
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {he.adminCommon.save}
        </Button>
      </form>
    </Form>
  );
}

export function RideTypesScreen() {
  const rideTypesQuery = useRideTypesAdmin();
  const [editing, setEditing] = useState<RideType | null | undefined>(undefined);
  const rideTypes = rideTypesQuery.data ?? [];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <PageHeader
        title={he.screen.admin.rideTypes}
        subtitle={he.adminRideTypes.subtitle}
        actions={
          <Button onClick={() => setEditing(null)}>
            <Plus className="me-1 size-4" /> {he.adminRideTypes.new}
          </Button>
        }
      />

      {rideTypes.length === 0 ? (
        <EmptyState icon={Signpost} message={he.adminRideTypes.empty} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{he.adminRideTypes.fieldNameHe}</TableHead>
              <TableHead>{he.adminRideTypes.fieldCode}</TableHead>
              <TableHead>{he.adminCommon.active}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rideTypes.map((rt) => (
              <TableRow key={rt.id} className="cursor-pointer" onClick={() => setEditing(rt)}>
                <TableCell>{rt.name_he}</TableCell>
                <TableCell dir="ltr">{rt.code}</TableCell>
                <TableCell>
                  <Badge variant={rt.is_active ? "default" : "outline"}>
                    {rt.is_active ? he.adminCommon.active : he.adminCommon.inactive}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Sheet open={editing !== undefined} onOpenChange={(open) => !open && setEditing(undefined)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{editing ? he.adminRideTypes.edit : he.adminRideTypes.new}</SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            {editing !== undefined ? <RideTypeForm rideType={editing} onSaved={() => setEditing(undefined)} /> : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
