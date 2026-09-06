import { zodResolver } from "@hookform/resolvers/zod";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { TimeField15 } from "@/components/TimeField15";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDestinations } from "@/features/fleet/hooks";
import { he } from "@/i18n/he";
import { showErrorToast } from "@/lib/rpc";
import { toast } from "sonner";

import {
  useCreateDepartmentMutation,
  useDepartmentCounts,
  useDepartmentsAdmin,
  useDepartmentSettings,
  useUpdateDepartmentMutation,
  useUpdateDepartmentSettingsMutation,
} from "../hooks";
import { departmentSchema, departmentSettingsSchema, type DepartmentFormValues, type DepartmentSettingsFormValues } from "../schema";
import type { Department } from "../api";

const DOW_LABELS = he.days.long;

function DepartmentForm({ department, onSaved }: { department: Department | null; onSaved: () => void }) {
  const destinationsQuery = useDestinations();
  const createMutation = useCreateDepartmentMutation();
  const updateMutation = useUpdateDepartmentMutation();
  const settingsQuery = useDepartmentSettings(department?.id);
  const updateSettingsMutation = useUpdateDepartmentSettingsMutation();

  const form = useForm<DepartmentFormValues>({
    resolver: zodResolver(departmentSchema),
    defaultValues: {
      name: department?.name ?? "",
      slug: department?.slug ?? "",
      home_destination_id: department?.home_destination_id ?? null,
      is_active: department?.is_active ?? true,
    },
  });

  const settingsForm = useForm<DepartmentSettingsFormValues>({
    resolver: zodResolver(departmentSettingsSchema),
    values: settingsQuery.data
      ? {
          open_dow: settingsQuery.data.open_dow,
          open_time: settingsQuery.data.open_time,
          close_dow: settingsQuery.data.close_dow,
          close_time: settingsQuery.data.close_time,
          publish_dow: settingsQuery.data.publish_dow,
          publish_time: settingsQuery.data.publish_time,
          turnaround_minutes: settingsQuery.data.turnaround_minutes,
          day_end_time: settingsQuery.data.day_end_time,
          chauffeur_dwell_minutes: settingsQuery.data.chauffeur_dwell_minutes,
          detour_limit_minutes: settingsQuery.data.detour_limit_minutes,
          detour_limit_km: settingsQuery.data.detour_limit_km,
          closing_reminder_hours: settingsQuery.data.closing_reminder_hours,
          auto_apply_accepted_proposals: settingsQuery.data.auto_apply_accepted_proposals,
          board_start_time: settingsQuery.data.board_start_time,
        }
      : undefined,
  });

  async function onSubmit(values: DepartmentFormValues) {
    try {
      if (department) {
        await updateMutation.mutateAsync({ id: department.id, patch: values });
      } else {
        await createMutation.mutateAsync(values);
      }
      toast.success(he.adminCommon.savedToast);
      onSaved();
    } catch (error) {
      showErrorToast(error);
    }
  }

  async function onSubmitSettings(values: DepartmentSettingsFormValues) {
    if (!department) return;
    try {
      await updateSettingsMutation.mutateAsync({ departmentId: department.id, patch: values });
      toast.success(he.adminCommon.savedToast);
    } catch (error) {
      showErrorToast(error);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <Form {...form}>
        <form className="flex flex-col gap-4" onSubmit={form.handleSubmit(onSubmit)}>
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{he.adminDepartments.fieldName}</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="slug"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{he.adminDepartments.fieldSlug}</FormLabel>
                <FormControl>
                  <Input {...field} dir="ltr" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="home_destination_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{he.adminDepartments.fieldHomeDestination}</FormLabel>
                <Select value={field.value ?? undefined} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {(destinationsQuery.data ?? []).map((d) => (
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
          <FormField
            control={form.control}
            name="is_active"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center gap-2 space-y-0">
                <FormControl>
                  <Checkbox checked={field.value} onCheckedChange={(v) => field.onChange(!!v)} />
                </FormControl>
                <FormLabel className="!mt-0">{he.adminDepartments.fieldActive}</FormLabel>
              </FormItem>
            )}
          />
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {he.adminCommon.save}
          </Button>
        </form>
      </Form>

      {department ? (
        <Form {...settingsForm}>
          <form className="flex flex-col gap-4 border-t pt-6" onSubmit={settingsForm.handleSubmit(onSubmitSettings)}>
            <h3 className="font-semibold">{he.adminDepartments.sectionSettings}</h3>
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={settingsForm.control}
                name="open_dow"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{he.adminDepartments.fieldOpenDow}</FormLabel>
                    <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {DOW_LABELS.map((label, i) => (
                          <SelectItem key={label} value={String(i)}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
              <FormField
                control={settingsForm.control}
                name="open_time"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{he.adminDepartments.fieldOpenTime}</FormLabel>
                    <FormControl>
                      <TimeField15 value={field.value} onChange={field.onChange} min="00:00" max="23:45" />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={settingsForm.control}
                name="close_dow"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{he.adminDepartments.fieldCloseDow}</FormLabel>
                    <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {DOW_LABELS.map((label, i) => (
                          <SelectItem key={label} value={String(i)}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
              <FormField
                control={settingsForm.control}
                name="close_time"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{he.adminDepartments.fieldCloseTime}</FormLabel>
                    <FormControl>
                      <TimeField15 value={field.value} onChange={field.onChange} min="00:00" max="23:45" />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={settingsForm.control}
                name="publish_dow"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{he.adminDepartments.fieldPublishDow}</FormLabel>
                    <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {DOW_LABELS.map((label, i) => (
                          <SelectItem key={label} value={String(i)}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
              <FormField
                control={settingsForm.control}
                name="publish_time"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{he.adminDepartments.fieldPublishTime}</FormLabel>
                    <FormControl>
                      <TimeField15 value={field.value} onChange={field.onChange} min="00:00" max="23:45" />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={settingsForm.control}
                name="turnaround_minutes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{he.adminDepartments.fieldTurnaround}</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step={15}
                        value={field.value}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={settingsForm.control}
                name="day_end_time"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{he.adminDepartments.fieldDayEnd}</FormLabel>
                    <FormControl>
                      <TimeField15 value={field.value} onChange={field.onChange} min="00:00" max="23:45" />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={settingsForm.control}
                name="chauffeur_dwell_minutes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{he.adminDepartments.fieldChauffeurDwell}</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        value={field.value}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={settingsForm.control}
                name="detour_limit_minutes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{he.adminDepartments.fieldDetourMinutes}</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        value={field.value}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={settingsForm.control}
                name="detour_limit_km"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{he.adminDepartments.fieldDetourKm}</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step={0.5}
                        value={field.value}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={settingsForm.control}
                name="closing_reminder_hours"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{he.adminDepartments.fieldClosingReminders}</FormLabel>
                    <FormControl>
                      <Input
                        dir="ltr"
                        value={field.value.join(",")}
                        onChange={(e) =>
                          field.onChange(
                            e.target.value
                              .split(",")
                              .map((s) => Number(s.trim()))
                              .filter((n) => !Number.isNaN(n)),
                          )
                        }
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={settingsForm.control}
                name="board_start_time"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{he.adminDepartments.fieldBoardStart}</FormLabel>
                    <FormControl>
                      <TimeField15 value={field.value} onChange={field.onChange} min="00:00" max="23:45" />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={settingsForm.control}
                name="auto_apply_accepted_proposals"
                render={({ field }) => (
                  <FormItem className="col-span-2 flex flex-row items-center gap-2 space-y-0">
                    <FormControl>
                      <Checkbox checked={field.value} onCheckedChange={(v) => field.onChange(!!v)} />
                    </FormControl>
                    <FormLabel className="!mt-0">{he.adminDepartments.fieldAutoApply}</FormLabel>
                  </FormItem>
                )}
              />
            </div>
            <Button type="submit" disabled={settingsForm.formState.isSubmitting}>
              {he.adminCommon.save}
            </Button>
          </form>
        </Form>
      ) : null}
    </div>
  );
}

export function DepartmentsScreen() {
  const departmentsQuery = useDepartmentsAdmin();
  const countsQuery = useDepartmentCounts();
  const [editing, setEditing] = useState<Department | null | undefined>(undefined);

  const departments = departmentsQuery.data ?? [];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <PageHeader
        title={he.screen.admin.departments}
        subtitle={he.adminDepartments.subtitle}
        actions={
          <Button onClick={() => setEditing(null)}>
            <Plus className="me-1 size-4" /> {he.adminDepartments.new}
          </Button>
        }
      />

      {departments.length === 0 ? (
        <EmptyState icon={Plus} message={he.adminDepartments.empty} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{he.adminCommon.name}</TableHead>
              <TableHead>{he.adminDepartments.columnMembers}</TableHead>
              <TableHead>{he.adminDepartments.columnCars}</TableHead>
              <TableHead>{he.adminCommon.active}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {departments.map((dept) => (
              <TableRow key={dept.id} className="cursor-pointer" onClick={() => setEditing(dept)}>
                <TableCell>{dept.name}</TableCell>
                <TableCell>
                  <span dir="ltr">{countsQuery.data?.members[dept.id] ?? 0}</span>
                </TableCell>
                <TableCell>
                  <span dir="ltr">{countsQuery.data?.cars[dept.id] ?? 0}</span>
                </TableCell>
                <TableCell>{dept.is_active ? he.adminCommon.active : he.adminCommon.inactive}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Sheet open={editing !== undefined} onOpenChange={(open) => !open && setEditing(undefined)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{editing ? he.adminDepartments.edit : he.adminDepartments.new}</SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            {editing !== undefined ? (
              <DepartmentForm department={editing} onSaved={() => setEditing(undefined)} />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
