export function formatUsdcAmount(amount: number, withPrefix = false): string {
  const prefix = withPrefix ? '$' : '';
  if (!Number.isFinite(amount) || amount === 0) return `${prefix}0.00`;
  if (amount >= 1) return `${prefix}${amount.toFixed(2)}`;
  if (amount >= 0.01) return `${prefix}${amount.toFixed(3)}`;
  if (amount >= 0.0001) return `${prefix}${amount.toFixed(4)}`;
  return withPrefix ? '<$0.0001' : '<0.0001';
}
