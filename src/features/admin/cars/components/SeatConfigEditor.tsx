import { Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { he } from "@/i18n/he";
import { fits } from "@/solver";

import { findDominatedIndices, SEAT_CONFIG_PRESETS } from "../lib/seatConfig";

import type { Passengers } from "@/solver";

let keySeq = 0;
function nextKey(): string {
  keySeq += 1;
  return `row-${keySeq}`;
}

interface Row extends Passengers {
  key: string;
}

interface SeatConfigEditorProps {
  initial: Passengers[];
  onChange: (configs: Passengers[]) => void;
}

/**
 * Table of allowed (adults, childSeats, boosters) combinations for a car
 * (docs/UX_FLOWS.md §5.4). Dominance validation and the quick fit tester
 * reuse the solver's own `dominates()`/`fits()` (`src/solver/seatFit.ts`) so
 * "this row is redundant" here means exactly what the solver's seat-fit
 * check means — no second implementation to drift out of sync.
 */
export function SeatConfigEditor({ initial, onChange }: SeatConfigEditorProps) {
  const [rows, setRows] = useState<Row[]>(() => initial.map((r) => ({ ...r, key: nextKey() })));
  const [testAdults, setTestAdults] = useState(1);
  const [testChildSeats, setTestChildSeats] = useState(0);
  const [testBoosters, setTestBoosters] = useState(0);

  const dominatedIndices = new Set(findDominatedIndices(rows));

  function commit(next: Row[]) {
    setRows(next);
    onChange(next.map(({ key: _key, ...rest }) => rest));
  }

  function updateRow(index: number, patch: Partial<Passengers>) {
    commit(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function removeRow(index: number) {
    commit(rows.filter((_, i) => i !== index));
  }

  function addRow() {
    commit([...rows, { key: nextKey(), adults: 1, childSeats: 0, boosters: 0 }]);
  }

  function loadPreset(labelKey: string) {
    const preset = SEAT_CONFIG_PRESETS.find((p) => p.labelKey === labelKey);
    if (!preset) return;
    commit(preset.configs.map((c) => ({ ...c, key: nextKey() })));
  }

  const testFits = fits({ id: "test", name: "test", type: "shared", seatConfigs: rows, features: [], luggageCapacity: 1, maintenance: [] }, {
    adults: testAdults,
    childSeats: testChildSeats,
    boosters: testBoosters,
  });
  const matchingConfig = rows.find(
    (r) => r.adults >= testAdults && r.childSeats >= testChildSeats && r.boosters >= testBoosters,
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h4 className="font-medium">{he.cars.seatConfigs}</h4>
        <Select onValueChange={loadPreset} value="">
          <SelectTrigger className="w-40">
            <SelectValue placeholder={he.action.loadPreset} />
          </SelectTrigger>
          <SelectContent>
            {SEAT_CONFIG_PRESETS.map((p) => (
              <SelectItem key={p.labelKey} value={p.labelKey}>
                {he.adminCars[p.labelKey]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {rows.length === 0 ? <p className="text-sm text-destructive">{he.adminCars.seatConfigEmptyWarning}</p> : null}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{he.adminCars.seatConfigColumnAdults}</TableHead>
            <TableHead>{he.adminCars.seatConfigColumnChildSeats}</TableHead>
            <TableHead>{he.adminCars.seatConfigColumnBoosters}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={row.key} className={dominatedIndices.has(i) ? "bg-amber-50 dark:bg-amber-950" : undefined}>
              <TableCell>
                <Input
                  type="number"
                  min={0}
                  className="w-20"
                  value={row.adults}
                  onChange={(e) => updateRow(i, { adults: Number(e.target.value) })}
                />
              </TableCell>
              <TableCell>
                <Input
                  type="number"
                  min={0}
                  className="w-20"
                  value={row.childSeats}
                  onChange={(e) => updateRow(i, { childSeats: Number(e.target.value) })}
                />
              </TableCell>
              <TableCell>
                <Input
                  type="number"
                  min={0}
                  className="w-20"
                  value={row.boosters}
                  onChange={(e) => updateRow(i, { boosters: Number(e.target.value) })}
                />
              </TableCell>
              <TableCell>
                <Button type="button" size="icon" variant="ghost" onClick={() => removeRow(i)} aria-label={he.adminCommon.delete}>
                  <Trash2 className="size-4" />
                </Button>
                {dominatedIndices.has(i) ? (
                  <p className="text-xs text-amber-700 dark:text-amber-300">{he.adminCars.seatConfigDominatedWarning}</p>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Button type="button" variant="outline" onClick={addRow} className="self-start">
        {he.action.addConfig}
      </Button>

      <div className="rounded-md border p-3">
        <h4 className="mb-2 font-medium">{he.cars.quickCheck}</h4>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            {he.adminCars.quickCheckAdults}
            <Input type="number" min={0} className="w-20" value={testAdults} onChange={(e) => setTestAdults(Number(e.target.value))} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {he.adminCars.quickCheckChildSeats}
            <Input
              type="number"
              min={0}
              className="w-20"
              value={testChildSeats}
              onChange={(e) => setTestChildSeats(Number(e.target.value))}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {he.adminCars.quickCheckBoosters}
            <Input
              type="number"
              min={0}
              className="w-20"
              value={testBoosters}
              onChange={(e) => setTestBoosters(Number(e.target.value))}
            />
          </label>
          <span className={testFits ? "font-medium text-green-700 dark:text-green-400" : "font-medium text-destructive"}>
            {testFits ? he.adminCars.quickCheckFits : he.adminCars.quickCheckDoesNotFit}
          </span>
          {testFits && matchingConfig ? (
            <span className="text-sm text-muted-foreground">
              {he.adminCars.quickCheckViaConfig.replace(
                "{{config}}",
                `${matchingConfig.adults}/${matchingConfig.childSeats}/${matchingConfig.boosters}`,
              )}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
