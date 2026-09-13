import { expect, test } from 'bun:test';
import { isIndexingStalled, shouldPageIndexingOutcome } from './indexing-exit';

test('a backlogged run that banked no ground and moved no cursor is stalled', () => {
  expect(
    isIndexingStalled(
      { checkpoint: '55909035' },
      { status: 'catching_up', errorCode: 'budget', checkpoint: '55909035',
        checkedCount: 0, insertedCount: 0, pendingCount: 5868483 },
    ),
  ).toBe(true);
});

test('a bounded run that still scanned blocks is progress, not a stall', () => {
  expect(
    isIndexingStalled(
      { checkpoint: '53629035' },
      { status: 'catching_up', errorCode: 'budget', checkpoint: '55909035',
        checkedCount: 50000, insertedCount: 398, pendingCount: 5868483 },
    ),
  ).toBe(false);
});

test('an idle path with no backlog cannot stall', () => {
  expect(
    isIndexingStalled(
      { checkpoint: '77339950' },
      { status: 'caught_up', checkpoint: '77339950',
        checkedCount: 0, insertedCount: 0, pendingCount: 0 },
    ),
  ).toBe(false);
});

test('a path with no prior state has nothing to compare and cannot stall', () => {
  expect(
    isIndexingStalled(null, {
      status: 'catching_up', checkpoint: '1', checkedCount: 0, insertedCount: 0, pendingCount: 10,
    }),
  ).toBe(false);
});

test('a path that reports no cursor at all offers no evidence of a stall', () => {
  // solana/registry reports `pendingCount` from a manual --from-offset and never
  // a checkpoint, so "both null" must not read as "the cursor did not move".
  expect(
    isIndexingStalled(
      { checkpoint: null },
      { status: 'catching_up', checkedCount: 0, insertedCount: 0, pendingCount: 900 },
    ),
  ).toBe(false);
});

test('a run that inserted rows without advancing the cursor is not stalled', () => {
  expect(
    isIndexingStalled(
      { checkpoint: '2650' },
      { status: 'catching_up', checkpoint: '2650',
        checkedCount: 0, insertedCount: 86, pendingCount: 1582 },
    ),
  ).toBe(false);
});

test('a caught-up tip carrying retained coverage gaps is disclosed debt, not a page', () => {
  expect(
    shouldPageIndexingOutcome({
      status: 'catching_up',
      errorCode: 'archive_gap',
      checkpoint: '61777544',
      head: '61777544',
      checkedCount: 335,
      pendingCount: 0,
      insertedCount: 0,
      unresolvedCount: 0,
      gapCount: 1,
    }),
  ).toBe(false);
});

test('an unattributed settlement backlog does not page while the scan keeps moving', () => {
  expect(
    shouldPageIndexingOutcome({
      status: 'catching_up',
      errorCode: 'batch_limit',
      checkpoint: '1170',
      head: '850097',
      checkedCount: 200,
      pendingCount: 1582,
      insertedCount: 86,
      unresolvedCount: 1397,
      gapCount: 0,
    }),
  ).toBe(false);
});

test('a bounded budget stop that still scanned blocks is progress, not a page', () => {
  expect(
    shouldPageIndexingOutcome({
      status: 'catching_up',
      errorCode: 'budget',
      checkpoint: '53629035',
      head: '61737239',
      checkedCount: 50000,
      pendingCount: 8108204,
      insertedCount: 398,
      unresolvedCount: 0,
      gapCount: 0,
    }),
  ).toBe(false);
});

test('an infrastructure fault pages', () => {
  expect(
    shouldPageIndexingOutcome({ status: 'failed', errorCode: 'rpc_unavailable' }),
  ).toBe(true);
});

test('a lost lease pages', () => {
  expect(
    shouldPageIndexingOutcome({ status: 'lease_lost', errorCode: 'lease_lost' }),
  ).toBe(true);
});

test('a path owned by another worker is silent', () => {
  expect(shouldPageIndexingOutcome({ status: 'busy' })).toBe(false);
});

test('an empty configured target is dormant, not a page', () => {
  expect(
    shouldPageIndexingOutcome({ status: 'dormant', errorCode: 'empty_seed' }),
  ).toBe(false);
});

test('a run that examined nothing while a backlog waits pages as a stall', () => {
  expect(
    shouldPageIndexingOutcome({
      status: 'catching_up',
      errorCode: 'budget',
      checkpoint: '55909035',
      head: '61777518',
      checkedCount: 0,
      pendingCount: 5868483,
      insertedCount: 0,
      unresolvedCount: 0,
      gapCount: 0,
      stalled: true,
    }),
  ).toBe(true);
});

test('an idle path with no backlog is not a stall', () => {
  expect(
    shouldPageIndexingOutcome({
      status: 'caught_up',
      checkpoint: '77339950',
      head: '77339950',
      checkedCount: 154,
      pendingCount: 0,
      insertedCount: 0,
      unresolvedCount: 0,
      gapCount: 0,
    }),
  ).toBe(false);
});
