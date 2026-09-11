// src/solver/rules/peopleServed.ts
import { ruleDescription } from '../reasons';
import type { Rule } from './types';
import { validatePositiveNumberParam } from './types';

export interface PeopleServedParams {
  cap: number;
}

export const peopleServed: Rule<PeopleServedParams> = {
  type: 'peopleServed',
  normalization: 'unit',
  defaultParams: { cap: 4 },
  validateParams(raw) {
    return { cap: validatePositiveNumberParam(raw, 'cap', 'PEOPLESERVED_CAP_INVALID') };
  },
  describe() {
    return ruleDescription('RULE_PEOPLESERVED_DESC');
  },
  score(ctx, request) {
    const paired = ctx.batch.relayPairPeople?.get(request.id);
    const people =
      paired ??
      request.passengers.adults + request.passengers.childSeats + request.passengers.boosters - 1;
    return Math.min(Math.max(people, 0) / ctx.params.cap, 1);
  },
};
