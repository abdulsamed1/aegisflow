/**
 * Booking flow orchestrator — pure decision helpers for reverify/retry.
 * Keeps scheduled() thin and testable; no I/O here.
 *  10 lines, no deps
 */

export type ReverifyResult = "PROCEED" | "ABORT_SLOT_GONE" | "ABORT_UNKNOWN";

export type BookingStep = "STARTED" | "SUBMITTED" | "RETRY" | "FAILED" | "SLOT_GONE";

export const PORTAL_URL = "https://appointment.bmeia.gv.at";

// Instant slot alarm (operator applies manually IN PARALLEL while the bot runs
// the wizard). Actionable in seconds: who, which week, where to click. No PII
// beyond the first name — speed needs no passport numbers.
export function buildSlotAlarmMessage(slot: { jobId: string; clientName: string; week: string }): string {
  return (
    `🚨 *SLOTS AVAILABLE — apply NOW (bot launching in parallel)*\n\n` +
    `Job: \`${slot.jobId}\` — Client: \`${slot.clientName}\`\n` +
    `Week: \`${slot.week}\`\n` +
    `Portal: ${PORTAL_URL} (Office KAIRO)\n\n` +
    `Open the site and apply manually — the bot wizard is launching too.`
  );
}

// Per-step booking outcome alerts — one text per terminal/transition event so
// the operator can follow every step live. FAILED always carries the
// never-parked notice: the job stays ACTIVE and retries next tick.
export function buildBookingStepMessage(
  step: BookingStep,
  d: {
    jobId: string;
    week: string;
    attempt: number;
    classification?: string;
    error?: string;
    stage?: string;
    slot?: string;
  }
): string {
  const head = `Job: \`${d.jobId}\` — Week: \`${d.week}\` (attempt ${d.attempt})`;
  switch (step) {
    case "STARTED":
      return `🤖 *[BOOKING] Wizard launching*\n\n${head}`;
    case "SUBMITTED":
      return (
        `📤 *[SUBMITTED] Form sent, awaiting confirmation*\n\n${head}\n` +
        `Slot: \`${d.slot || "?"}\` — Stage: \`${d.stage || "?"}\``
      );
    case "RETRY":
      return (
        `🔁 *[RETRY] Attempt ${d.attempt} failed — retrying once*\n\n${head}\n` +
        `Classification: \`${d.classification || "UNKNOWN"}\`\nError: \`${d.error || "n/a"}\``
      );
    case "FAILED":
      return (
        `❌ *[BOOKING FAILED] Attempt ${d.attempt}*\n\n${head}\n` +
        `Classification: \`${d.classification || "UNKNOWN"}\`\nError: \`${d.error || "n/a"}\`\n` +
        `Job stays ACTIVE — retrying next tick while slots verify.`
      );
    case "SLOT_GONE":
      return (
        `⚠️ *[SLOT GONE] Vanished at reverify — bot stood down*\n\n${head}\n` +
        `Stop manual effort unless you already secured it.`
      );
  }
}

// Operator policy (2026-09-11): a failed booking must NEVER park the job.
// check_count grows ~16-48 per scan tick, so the old
// getBackoffUntilISO(checkCount) parked every failed job the full 60-min cap.
// Requeue tick-eligible (NULL backoff) instead — retries resume next cron tick
// while slots verify. Safety valves stay: single same-tick retry, 20s launch
// throttle, per-job DO lock, reverify gate, 540s circuit breaker.
export function getBookingFailureBackoffUntil(): string | null {
  return null;
}

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
