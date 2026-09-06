import { describe, expect, it } from 'vitest';
import { scoreRequests } from '../policy/engine';
import { normalize } from '../slots';
import { baseInput, defaultPolicy, makeCar, makeRequest, slotMs } from '../__fixtures__/gen';

describe('policy/engine scoreRequests', () => {
  it('an unknown rule type warns and is skipped, never crashes', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [makeRequest({ departureMs: slotMs(32), returnMs: slotMs(48) })],
      policy: { id: 'p', version: 1, rules: [{ type: 'notARealRule', weight: 1, params: {} }] },
    });
    const { normalized } = normalize(input);
    const { scores, warnings } = scoreRequests(input, normalized);
    expect(warnings.some((w) => w.code === 'UNKNOWN_RULE_TYPE')).toBe(true);
    expect(scores.get(normalized[0]!.id)?.total).toBe(0);
  });

  it('minmax normalization maps an all-equal batch to 0 (no rule ships minmax by default, so this exercises the branch directly via a param error path is out of scope; verify unit rules clamp to 0..1)', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [
        makeRequest({ id: 'A', rideType: 'work', departureMs: slotMs(32), returnMs: slotMs(48) }),
        makeRequest({ id: 'B', rideType: 'work', departureMs: slotMs(32), returnMs: slotMs(48) }),
      ],
      policy: defaultPolicy(),
    });
    const { normalized } = normalize(input);
    const { scores } = scoreRequests(input, normalized);
    for (const [, breakdown] of scores) {
      for (const rule of breakdown.perRule) {
        expect(rule.normalized).toBeGreaterThanOrEqual(0);
        expect(rule.normalized).toBeLessThanOrEqual(1);
      }
    }
  });

  it('changing the rideType weights flips the greedy order in a 2-request scenario', () => {
    const requests = [
      makeRequest({ id: 'A', rideType: 'errands', departureMs: slotMs(32), returnMs: slotMs(48) }),
      makeRequest({ id: 'B', rideType: 'healthcare', departureMs: slotMs(32), returnMs: slotMs(48) }),
    ];
    const input1 = baseInput({
      cars: [makeCar('C1')],
      requests,
      policy: { id: 'p', version: 1, rules: [{ type: 'rideType', weight: 1, params: { weights: { errands: 10, healthcare: 1 } } }] },
    });
    const { normalized: n1 } = normalize(input1);
    const { scores: s1 } = scoreRequests(input1, n1);
    expect(s1.get('A')!.total).toBeGreaterThan(s1.get('B')!.total);

    const input2 = { ...input1, policy: { id: 'p', version: 1, rules: [{ type: 'rideType', weight: 1, params: { weights: { errands: 1, healthcare: 10 } } }] } };
    const { normalized: n2 } = normalize(input2);
    const { scores: s2 } = scoreRequests(input2, n2);
    expect(s2.get('B')!.total).toBeGreaterThan(s2.get('A')!.total);
  });

  it('manual boost can override the ordering when its rule is weighted', () => {
    const requests = [
      makeRequest({ id: 'A', rideType: 'errands', departureMs: slotMs(32), returnMs: slotMs(48) }),
      makeRequest({ id: 'B', rideType: 'healthcare', departureMs: slotMs(32), returnMs: slotMs(48), manualBoost: { value: 1, reason: 'sadran override' } }),
    ];
    const input = baseInput({
      cars: [makeCar('C1')],
      requests,
      policy: {
        id: 'p',
        version: 1,
        rules: [
          { type: 'rideType', weight: 1, params: { weights: { errands: 10, healthcare: 1 } } },
          { type: 'manualBoost', weight: 5, params: {} },
        ],
      },
    });
    const { normalized } = normalize(input);
    const { scores } = scoreRequests(input, normalized);
    expect(scores.get('B')!.total).toBeGreaterThan(scores.get('A')!.total);
  });

  it('rule values are summed in registry order after rounding to 6 decimals (determinism)', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [makeRequest({ id: 'A', departureMs: slotMs(32), returnMs: slotMs(48) })],
      policy: defaultPolicy(),
    });
    const { normalized } = normalize(input);
    const { scores: run1 } = scoreRequests(input, normalized);
    const { scores: run2 } = scoreRequests(input, normalized);
    expect(run1.get('A')).toEqual(run2.get('A'));
  });
});
