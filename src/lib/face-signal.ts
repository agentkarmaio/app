/**
 * "Does this karma face have signal worth reading?" — one answer for every
 * surface that renders a face block (v2 score route, MCP/A2A resolver).
 *
 * Live path: a provider face has real signal when Tier 1 (receipts) or Tier 3
 * (declared identity) is present. Tier 2 alone is ambiguous — could be consumer
 * behavior mislabelled as provider.
 *
 * Stored path (no live transactions, e.g. registry-only agents): the persisted
 * score IS the evidence — a rated Tier-3 declared score is signal, `Unrated` is
 * not. Without this, every declared score read as "no signal" beside a real
 * number.
 */
export function hasProviderSignal(t: { tier1?: number | null; tier3?: number | null }): boolean {
  return (t.tier1 != null && t.tier1 >= 0) || (t.tier3 != null && t.tier3 >= 0);
}

export function storedProviderHasSignal(
  row: { provider_score?: number | string | null; trust_tier?: string | null } | null | undefined,
): boolean {
  return row?.provider_score != null && row.trust_tier != null && row.trust_tier !== 'Unrated';
}

export function storedConsumerHasSignal(
  row: { consumer_score?: number | string | null } | null | undefined,
): boolean {
  return row?.consumer_score != null;
}
