import type { TireState } from "@/lib/enums";

/** The columns of `cars` the dashboard reads (+ the replacement flag embedded from `car_access_codes`). */
export interface OverviewCar {
  id: string;
  name: string;
  license_plate: string;
  status: "active" | "maintenance" | "retired";
  type: "shared" | "temporary";
  retired_at: string | null;
  codes: { is_replaced: boolean } | { is_replaced: boolean }[] | null;
}

export interface OverviewKm {
  car_id: string;
  km: number;
  recorded_at: string;
}

export interface OverviewCareEvent {
  car_id: string;
  kind: "tire_fill" | "wash";
  created_at: string;
  tires: unknown;
}

/** The checklist agent's per-car status (REQ item 150 d): green or not green as of a date, with what failed. */
export interface ChecklistStatus {
  green: boolean;
  date: string;
  failed: string[];
}

export interface CarOverviewRow {
  id: string;
  name: string;
  licensePlate: string;
  status: OverviewCar["status"];
  isReplacement: boolean;
  km: { km: number; at: string } | null;
  checklist: ChecklistStatus | null;
  tireFill: { at: string; worst: TireState } | null;
  wash: { at: string } | null;
}

/** Severity order of a tyre fill; `unchecked` positions are skipped (they carry no information). */
const TIRE_SEVERITY: Record<TireState, number> = { unchecked: 0, ok: 1, low: 2, very_low: 3 };

/** The worst state among a tyre-fill event's positions (`unchecked` when none was checked or the payload is malformed). */
export function worstTire(tires: unknown): TireState {
  if (!tires || typeof tires !== "object") return "unchecked";
  let worst: TireState = "unchecked";
  for (const value of Object.values(tires as Record<string, unknown>)) {
    if (typeof value === "string" && value in TIRE_SEVERITY && TIRE_SEVERITY[value as TireState] > TIRE_SEVERITY[worst]) {
      worst = value as TireState;
    }
  }
  return worst;
}

function isReplaced(codes: OverviewCar["codes"]): boolean {
  const flat = Array.isArray(codes) ? codes[0] : codes;
  return !!flat?.is_replaced;
}

/**
 * One row per shared, non-retired car (private/temporary cars are never on the dashboard), sorted by name.
 * `careEvents` may be in any order; the latest event of each kind per car wins.
 */
export function buildCarOverviewRows(input: {
  cars: OverviewCar[];
  km: OverviewKm[];
  careEvents: OverviewCareEvent[];
  checklists?: Record<string, ChecklistStatus> | undefined;
}): CarOverviewRow[] {
  const kmByCar = new Map(input.km.map((reading) => [reading.car_id, reading]));
  const latest = new Map<string, OverviewCareEvent>();
  for (const event of input.careEvents) {
    const key = `${event.car_id}:${event.kind}`;
    const previous = latest.get(key);
    if (!previous || event.created_at > previous.created_at) latest.set(key, event);
  }
  return input.cars
    .filter((car) => car.type === "shared" && car.status !== "retired" && !car.retired_at)
    .map((car): CarOverviewRow => {
      const reading = kmByCar.get(car.id);
      const tire = latest.get(`${car.id}:tire_fill`);
      const wash = latest.get(`${car.id}:wash`);
      return {
        id: car.id,
        name: car.name,
        licensePlate: car.license_plate,
        status: car.status,
        isReplacement: isReplaced(car.codes),
        km: reading ? { km: reading.km, at: reading.recorded_at } : null,
        checklist: input.checklists?.[car.id] ?? null,
        tireFill: tire ? { at: tire.created_at, worst: worstTire(tire.tires) } : null,
        wash: wash ? { at: wash.created_at } : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "he") || a.id.localeCompare(b.id));
}
