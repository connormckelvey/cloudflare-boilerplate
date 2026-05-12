export function computeBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: number
): number {
  const exponential = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
  const jitterAmount = exponential * jitter * Math.random();
  return Math.floor(exponential + jitterAmount);
}
