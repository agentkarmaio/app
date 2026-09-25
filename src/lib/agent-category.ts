/** Category slugs an agent may declare, and the label every profile renders them as. */
const CATEGORY_LABELS: Record<string, string> = {
  ai: 'AI / ML',
  data: 'Data Feed',
  defi: 'DeFi',
  infra: 'Infrastructure',
  social: 'Social',
  utility: 'Utility',
  other: 'Other',
};

/** Unknown slugs pass through verbatim — declared metadata is not ours to drop. */
export function categoryLabel(slug: string | null | undefined): string | null {
  const trimmed = slug?.trim();
  if (!trimmed) return null;
  return CATEGORY_LABELS[trimmed] ?? trimmed;
}
