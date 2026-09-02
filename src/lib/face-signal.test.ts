import { describe, expect, test } from 'bun:test';
import { hasProviderSignal, storedProviderHasSignal, storedConsumerHasSignal } from './face-signal';

describe('hasProviderSignal (live path)', () => {
  test('tier1 or tier3 present → true; tier2 alone → false', () => {
    expect(hasProviderSignal({ tier1: 0.4, tier3: null })).toBe(true);
    expect(hasProviderSignal({ tier1: null, tier3: 0 })).toBe(true);
    expect(hasProviderSignal({ tier1: null, tier3: null })).toBe(false);
  });
});

describe('stored-row path', () => {
  test('a rated declared score counts as provider signal', () => {
    expect(storedProviderHasSignal({ provider_score: 55, trust_tier: 'Fair' })).toBe(true);
  });
  test('Unrated or missing score → no provider signal', () => {
    expect(storedProviderHasSignal({ provider_score: 0, trust_tier: 'Unrated' })).toBe(false);
    expect(storedProviderHasSignal({ provider_score: null, trust_tier: 'Fair' })).toBe(false);
    expect(storedProviderHasSignal(null)).toBe(false);
  });
  test('consumer signal follows the stored consumer score', () => {
    expect(storedConsumerHasSignal({ consumer_score: 40 })).toBe(true);
    expect(storedConsumerHasSignal({ consumer_score: null })).toBe(false);
    expect(storedConsumerHasSignal(null)).toBe(false);
  });
});
