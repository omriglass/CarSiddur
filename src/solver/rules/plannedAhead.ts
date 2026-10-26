// src/solver/rules/plannedAhead.ts
//
// REQ §13.154 (g): a request filed from a reservation made long enough ahead, on one of the selected weekdays. Not in any
// policy until an admin adds it, so by default a reservation gives no precedence. The bridge supplies the request's
// Jerusalem weekdays (the solver does no wall-clock arithmetic); a multi-day request counts when any of its days is selected.
import { ruleDescription } from '../reasons';
import { PolicyParamsError } from '../types';
import type { Rule } from './types';
import { validatePositiveNumberParam } from './types';

export interface PlannedAheadParams {
  /** one switch per weekday, 0 = Sunday */
  days: boolean[];
  minLeadDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const plannedAhead: Rule<PlannedAheadParams> = {
  type: 'plannedAhead',
  normalization: 'unit',
  defaultParams: { days: [false, false, false, false, false, true, true], minLeadDays: 14 },
  validateParams(raw) {
    const days = (raw as { days?: unknown } | null)?.days;
    if (!Array.isArray(days) || days.length !== 7 || !days.every((d) => typeof d === 'boolean')) {
      throw new PolicyParamsError('PLANNEDAHEAD_DAYS_INVALID');
    }
    return {
      days: [...days] as boolean[],
      minLeadDays: validatePositiveNumberParam(raw, 'minLeadDays', 'PLANNEDAHEAD_LEAD_INVALID', { allowZero: true }),
    };
  },
  describe() {
    return ruleDescription('RULE_PLANNEDAHEAD_DESC');
  },
  score(ctx, request) {
    const planned = request.request.plannedAhead;
    if (!planned) return 0;
    const startMs = request.request.departureMs ?? request.request.returnMs;
    if (startMs === undefined || startMs - planned.reservedAtMs < ctx.params.minLeadDays * DAY_MS) return 0;
    return planned.weekdays.some((day) => ctx.params.days[day] === true) ? 1 : 0;
  },
};
