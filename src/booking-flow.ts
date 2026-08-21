/**
 * Booking flow orchestrator — pure decision helpers for reverify/retry.
 * Keeps scheduled() thin and testable; no I/O here.
 * ponytail: 10 lines, no deps
 */

export type ReverifyResult = "PROCEED" | "ABORT_SLOT_GONE" | "ABORT_UNKNOWN";

export function decideReverifyAction(scan: { status: string }): ReverifyResult {
  if (scan.status === "SLOTS") return "PROCEED";
  if (scan.status === "UNKNOWN") return "ABORT_UNKNOWN";
  return "ABORT_SLOT_GONE";
}

export function decideRetryAction(
  first: { success: boolean },
  rescan: { status: string },
  breakerTripped: boolean
): "RETRY" | "REQUEUE" {
  if (first.success) return "REQUEUE";
  if (breakerTripped) return "REQUEUE";
  if (rescan.status === "SLOTS") return "RETRY";
  return "REQUEUE";
}
