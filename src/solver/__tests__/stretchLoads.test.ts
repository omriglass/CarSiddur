// REQ item 246 h (LT1 phase 2a): seats per stretch - the TS half of the shared cases
// (supabase/tests/fixtures/stretch_load_cases.json; the SQL half is scripts/test-stretch-load-parity.mjs).
import { describe, expect, it } from 'vitest';

import cases from '../../../supabase/tests/fixtures/stretch_load_cases.json';
import { fitsAlong, stretchLoads, type StretchRider } from '../seatFit';
import type { Car } from '../types';

const car = (configs: number[][]): Car =>
  ({ seatConfigs: configs.map(([adults, childSeats, boosters]) => ({ adults: adults!, childSeats: childSeats!, boosters: boosters! })) }) as unknown as Car;

describe('stretchLoads (shared cases)', () => {
  for (const c of cases.cases) {
    it(c.name, () => {
      const riders = c.riders as StretchRider[];
      expect(stretchLoads(c.points, riders).map((l) => [l.adults, l.childSeats, l.boosters])).toEqual(c.loads);
      expect(fitsAlong(car(c.configs), c.points, riders)).toBe(c.fits);
    });
  }
});
