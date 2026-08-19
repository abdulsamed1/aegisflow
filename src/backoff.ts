/**
 * Exponential Backoff & Resource Circuit Breaker Manager
 * Conforms to Architectural Requirements FR-4 & NFR-2
 */

export function calculateBackoffMinutes(failureCount: number): number {
  if (failureCount <= 0) return 0;
  // Exponential scaling: 2^failureCount (min 2, max 60)
  const minutes = Math.pow(2, failureCount);
  return Math.min(minutes, 60);
}

export function getBackoffUntilISO(failureCount: number, baseDate: Date = new Date()): string {
  const minutes = calculateBackoffMinutes(failureCount);
  const backoffDate = new Date(baseDate.getTime() + minutes * 60 * 1000);
  return backoffDate.toISOString();
}

export const DAILY_BROWSER_BUDGET_SECONDS = 600.0;
export const CIRCUIT_BREAKER_THRESHOLD_SECONDS = 540.0; // 90% threshold (FR-4)

export function isCircuitBreakerTripped(totalBrowserSecondsToday: number): boolean {
  return totalBrowserSecondsToday >= CIRCUIT_BREAKER_THRESHOLD_SECONDS;
}
