import { zodResolver } from "@hookform/resolvers/zod";
import { formatInTimeZone } from "date-fns-tz";
import { MapPin, Plus } from "lucide-react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { he } from "@/i18n/he";
import { TZ } from "@/lib/time";
import { showErrorToast } from "@/lib/rpc";

import {
  useCreateDestinationMutation,
  useDestinationsAdmin,
  useFreeTextQueue,
  useMergeFreeTextMutation,
  useUpdateDestinationMutation,
} from "../hooks";
import { aliasesTextToArray, destinationSchema, type DestinationFormValues } from "../schema";
import type { Destination } from "../api";

const PT_SCORES = [0, 1, 2, 3, 4, 5] as const;

function DestinationForm({ destination, prefillName, onSaved }: { destination: Destination | null; prefillName?: string; onSaved: () => void }) {
  const createMutation = useCreateDestinationMutation();
  const updateMutation = useUpdateDestinationMutation();

  const form = useForm<DestinationFormValues>({
    resolver: zodResolver(destinationSchema),
    defaultValues: {
      name: destination?.name ?? prefillName ?? "",
      aliasesText: (destination?.aliases ?? []).join(", "),
      zone: destination?.zone ?? "unknown",
      distance_km: destination?.distance_km ?? null,
      travel_minutes: destination?.travel_minutes ?? null,
      public_transport_score: destination?.public_transport_score ?? null,
      is_approved: destination?.is_approved ?? true,
    },
  });

  async function onSubmit(values: DestinationFormValues) {
    const patch = {
      name: values.name,
      aliases: aliasesTextToArray(values.aliasesText),
      zone: values.zone,
      distance_km: values.distance_km,
      travel_minutes: values.travel_minutes,
      public_transport_score: values.public_transport_score,
      is_approved: values.is_approved,
    };
    try {
      if (destination) {
        await updateMutation.mutateAsync({ id: destination.id, patch });
      } else {
        await createMutation.mutateAsync(patch);
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
              <FormLabel>{he.adminDestinations.fieldName}</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="aliasesText"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{he.adminDestinations.fieldAliases}</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="zone"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{he.adminDestinations.fieldZone}</FormLabel>
              <FormControl>
                <Input {...field} dir="ltr" />
              </FormControl>
            </FormItem>
          )}
        />
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="distance_km"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{he.adminDestinations.fieldDistanceKm}</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    value={field.value ?? ""}
                    onChange={(e) => field.onChange(e.target.value === "" ? null : Number(e.target.value))}
                  />
                </FormControl>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="travel_minutes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{he.adminDestinations.fieldTravelMinutes}</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    value={field.value ?? ""}
                    onChange={(e) => field.onChange(e.target.value === "" ? null : Number(e.target.value))}
                  />
                </FormControl>
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="public_transport_score"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{he.adminDestinations.fieldPtScore}</FormLabel>
              <Select
                value={field.value === null ? undefined : String(field.value)}
                onValueChange={(v) => field.onChange(Number(v))}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {PT_SCORES.map((score) => (
                    <SelectItem key={score} value={String(score)}>
                      {score} — {he.destinations.ptScore[String(score) as "0"]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="is_approved"
          render={({ field }) => (
            <FormItem className="flex flex-row items-center gap-2 space-y-0">
              <FormControl>
                <Checkbox checked={field.value} onCheckedChange={(v) => field.onChange(!!v)} />
              </FormControl>
              <FormLabel className="!mt-0">{he.adminDestinations.fieldApproved}</FormLabel>
            </FormItem>
          )}
        />
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {he.adminCommon.save}
        </Button>
      </form>
    </Form>
  );
}

function ListTab() {
  const destinationsQuery = useDestinationsAdmin();
  const [editing, setEditing] = useState<Destination | null | undefined>(undefined);
  const destinations = destinationsQuery.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Button onClick={() => setEditing(null)} className="self-start">
        <Plus className="me-1 size-4" /> {he.adminDestinations.new}
      </Button>
      {destinations.length === 0 ? (
        <EmptyState icon={MapPin} message={he.adminDestinations.empty} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{he.adminDestinations.fieldName}</TableHead>
              <TableHead>{he.adminDestinations.fieldZone}</TableHead>
              <TableHead>{he.adminDestinations.fieldDistanceKm}</TableHead>
              <TableHead>{he.adminDestinations.fieldPtScore}</TableHead>
              <TableHead>{he.adminCommon.active}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {destinations.map((d) => (
              <TableRow key={d.id} className="cursor-pointer" onClick={() => setEditing(d)}>
                <TableCell>{d.name}</TableCell>
                <TableCell>{d.zone}</TableCell>
                <TableCell dir="ltr">{d.distance_km ?? "—"}</TableCell>
                <TableCell>
                  {d.public_transport_score !== null
                    ? he.destinations.ptScore[String(d.public_transport_score) as "0"]
                    : "—"}
                </TableCell>
                <TableCell>
                  <Badge variant={d.is_approved ? "default" : "outline"}>
                    {d.is_approved ? he.adminCommon.active : he.adminCommon.inactive}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Sheet open={editing !== undefined} onOpenChange={(open) => !open && setEditing(undefined)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{editing ? he.adminDestinations.edit : he.adminDestinations.new}</SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            {editing !== undefined ? <DestinationForm destination={editing} onSaved={() => setEditing(undefined)} /> : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function FreeTextQueueTab() {
  const queueQuery = useFreeTextQueue();
  const destinationsQuery = useDestinationsAdmin();
  const mergeMutation = useMergeFreeTextMutation();
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({});
  const [createFrom, setCreateFrom] = useState<string | null>(null);

  const queue = queueQuery.data ?? [];

  if (queue.length === 0) {
    return <EmptyState icon={MapPin} message={he.adminDestinations.emptyQueue} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{he.adminDestinations.queueMergeNote}</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{he.adminDestinations.fieldName}</TableHead>
            <TableHead>{he.adminDestinations.columnUsageCount}</TableHead>
            <TableHead>{he.adminDestinations.columnLastUsed}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {queue.map((row) => (
            <TableRow key={row.text}>
              <TableCell>{row.text}</TableCell>
              <TableCell dir="ltr">{row.count}</TableCell>
              <TableCell dir="ltr">{formatInTimeZone(new Date(row.lastUsedAt), TZ, "dd/MM/yyyy")}</TableCell>
              <TableCell className="flex flex-wrap items-center gap-2">
                <Select
                  value={mergeTargets[row.text] ?? ""}
                  onValueChange={(v) => setMergeTargets((s) => ({ ...s, [row.text]: v }))}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue placeholder={he.adminDestinations.queueMergeTarget} />
                  </SelectTrigger>
                  <SelectContent>
                    {(destinationsQuery.data ?? []).map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  disabled={!mergeTargets[row.text]}
                  onClick={async () => {
                    try {
                      await mergeMutation.mutateAsync({ destinationId: mergeTargets[row.text]!, freeText: row.text });
                      toast.success(he.adminCommon.savedToast);
                    } catch (error) {
                      showErrorToast(error);
                    }
                  }}
                >
                  {he.action.mergeInto}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setCreateFrom(row.text)}>
                  {he.action.createDestination}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Sheet open={!!createFrom} onOpenChange={(open) => !open && setCreateFrom(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{he.adminDestinations.new}</SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            {createFrom ? (
              <DestinationForm destination={null} prefillName={createFrom} onSaved={() => setCreateFrom(null)} />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

export function DestinationsScreen() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <PageHeader title={he.screen.admin.destinations} />
      <Tabs defaultValue="list">
        <TabsList>
          <TabsTrigger value="list">{he.adminDestinations.tabList}</TabsTrigger>
          <TabsTrigger value="queue">{he.destinations.freeTextQueue}</TabsTrigger>
        </TabsList>
        <TabsContent value="list">
          <ListTab />
        </TabsContent>
        <TabsContent value="queue">
          <FreeTextQueueTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
