import { expect, test } from 'bun:test';
import { coverageOutcome } from './indexing-jobs';
const coverage = { complete: false, checked: 0, pending: 10, unresolved: 0 };
test('a first-window provider throttle is failed, not successful catch-up', () => {
  expect(
    coverageOutcome({ ...coverage, reason: 'rate_limited' }, 0).status,
  ).toBe('failed');
});
test('bounded completed progress stays visible without claiming full success', () => {
  expect(
    coverageOutcome({ ...coverage, checked: 5, reason: 'budget' }, 2).status,
  ).toBe('catching_up');
});
test('irreversible scope gaps are distinct from retriable parse failures', () => {
  const r = coverageOutcome(
    { ...coverage, complete: true, pending: 0, gaps: 1 },
    0,
  );
  expect(r.status).toBe('catching_up');
  expect(r.gapCount).toBe(1);
  expect(r.unresolvedCount).toBe(0);
});
test('empty configured targets are dormant while failed address reads are failed', () => {
  expect(coverageOutcome({ ...coverage, reason: 'empty_seed' }, 0).status).toBe(
    'dormant',
  );
  expect(
    coverageOutcome({ ...coverage, reason: 'address_failure' }, 0).status,
  ).toBe('failed');
});
