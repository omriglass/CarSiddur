/** "62.8%" — one decimal place from a 0..1 rate. Caller wraps the result in `<span dir="ltr">`. */
export function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** Fixed-decimal formatting for hours/ride counts/policy scores. Caller wraps the result in `<span dir="ltr">`. */
export function formatDecimal(value: number, digits = 1): string {
  return value.toFixed(digits);
}
