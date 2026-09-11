/**
 * Booking flow orchestrator — pure decision helpers for reverify/retry.
 * Keeps scheduled() thin and testable; no I/O here.
 *  10 lines, no deps
 */

export type ReverifyResult = "PROCEED" | "ABORT_SLOT_GONE" | "ABORT_UNKNOWN";

export function decideReverifyAction(scan: { status: string }): ReverifyResult {
  if (scan.status === "SLOTS") return "PROCEED";
  if (scan.status === "UNKNOWN") return "ABORT_UNKNOWN";
  return "ABORT_SLOT_GONE";
}

export function decideRetryAction(
  first: { success: boolean; classification?: string },
  rescan: { status: string },
  breakerTripped: boolean
): "RETRY" | "REQUEUE" {
  if (first.success) return "REQUEUE";
  if (breakerTripped) return "REQUEUE";
  //  deterministic platform launch failures (prod 2026-09-06/08/10: mkdtemp
  // crash → blind retry → 429) never recover same-tick: requeue with backoff
  // so the orphaned remote session expires instead of burning budget.
  if (first.classification === "LAUNCH_ERROR") return "REQUEUE";
  if (rescan.status === "SLOTS") return "RETRY";
  return "REQUEUE";
}
