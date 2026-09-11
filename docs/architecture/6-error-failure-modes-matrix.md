# 6. Error & Failure Modes Matrix

| Failure Mode | Detection Indicator | System Reaction | Recovery Action |
|---|---|---|---|
| Portal Down / 5xx | HTTP 500 / 503 or Connection Timeout | Transition to `TEMPORARY_ERROR` | Exponential Backoff (2, 4, 8... mins) |
| Layout Shift / Unexpected DOM | Missing expected HTML elements | Transition to `PORTAL_ERROR` | Log DOM snippet + Alert Operator |
| Slot Disappeared Mid-Booking | "Slot no longer available" text | Transition to `BOOKING_FAILED` | Re-queue job to `ACTIVE` |
| Daily Browser Budget Reached (90%) | Cumulative browser time ≥ 540s | Trip safety circuit breaker | Halt new browser launches + Telegram Alert |
| Concurrent Worker Execution | DO Lock collision | First wins, second aborts immediately | Silent abort, zero duplicate submission |
| Browser Launch Platform Failure (`LAUNCH_ERROR`) | Launch-phase signal only: `fs.mkdtemp is not implemented`, `Unable to create new browser` (429), or `connectOverCDP` throw before a browser handle exists (neither HTTP/timeout nor DOM symptoms) | Classify as `LAUNCH_ERROR` | Re-queue job to `ACTIVE` with backoff and never same-tick retry, even when rescan shows `SLOTS`; never enumerate or close sessions (no handle exists and blind close kills other jobs — the orphaned remote session expires via Cloudflare idle timeout); the 20 second throttle slot stays consumed because remote acquire precedes the local crash |
