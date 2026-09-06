import { describe, expect, it } from 'vitest';
import { submissionTime } from '../submissionTime';
import { PolicyParamsError } from '../../types';
import { normalize } from '../../slots';
import { baseInput, makeCar, makeRequest, slotMs } from '../../__fixtures__/gen';

function normalizeBatch(requests: ReturnType<typeof makeRequest>[]) {
  const input = baseInput({ cars: [makeCar('C1')], requests });
  return normalize(input).normalized;
}
function ctx(batch: ReturnType<typeof normalizeBatch>, params = submissionTime.defaultParams) {
  return { params, policy: { id: '', version: 1, rules: [] }, stats: { fairness: {}, usualCarId: {} }, destinations: {}, batch: { requests: batch, size: batch.length } };
}

describe('rules/submissionTime', () => {
  it('simultaneous submissions all rank 0 (no one submitted strictly earlier)', () => {
    const batch = normalizeBatch([
      makeRequest({ id: 'A', submittedAtMs: 100, departureMs: slotMs(32), returnMs: slotMs(48) }),
      makeRequest({ id: 'B', submittedAtMs: 100, departureMs: slotMs(32), returnMs: slotMs(48) }),
    ]);
    for (const nr of batch) expect(submissionTime.score(ctx(batch), nr)).toBe(1);
  });

  it('a later submission scores lower than an earlier one', () => {
    const batch = normalizeBatch([
      makeRequest({ id: 'A', submittedAtMs: 100, departureMs: slotMs(32), returnMs: slotMs(48) }),
      makeRequest({ id: 'B', submittedAtMs: 200, departureMs: slotMs(32), returnMs: slotMs(48) }),
    ]);
    const scoreA = submissionTime.score(ctx(batch), batch[0]!);
    const scoreB = submissionTime.score(ctx(batch), batch[1]!);
    expect(scoreB).toBeLessThan(scoreA);
  });

  it('late requests use the penalty formula, demoting them relative to on-time', () => {
    const batch = normalizeBatch([
      makeRequest({ id: 'A', isLate: true, departureMs: slotMs(32), returnMs: slotMs(48) }),
      makeRequest({ id: 'B', isLate: false, departureMs: slotMs(32), returnMs: slotMs(48) }),
    ]);
    const late = submissionTime.score(ctx(batch, { latePenalty: 1 }), batch[0]!);
    const onTime = submissionTime.score(ctx(batch, { latePenalty: 1 }), batch[1]!);
    expect(late).toBeLessThan(onTime);
    expect(late).toBe(0); // max(0, 0.7 - 1) clamps to 0
  });

  it('validateParams rejects a negative latePenalty', () => {
    expect(() => submissionTime.validateParams({ latePenalty: -1 })).toThrow(PolicyParamsError);
  });
});
