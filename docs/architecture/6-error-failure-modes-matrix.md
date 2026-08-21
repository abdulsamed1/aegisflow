# 6. Error & Failure Modes Matrix

| Failure Mode | Detection Indicator | System Reaction | Recovery Action |
|---|---|---|---|
| Portal Down / 5xx | HTTP 500 / 503 or Connection Timeout | Transition to `TEMPORARY_ERROR` | Exponential Backoff (2, 4, 8... mins) |
| Layout Shift / Unexpected DOM | Missing expected HTML elements | Transition to `PORTAL_ERROR` | Log DOM snippet + Alert Operator |
| Slot Disappeared Mid-Booking | "Slot no longer available" text | Transition to `BOOKING_FAILED` | Re-queue job to `ACTIVE` |
| Daily Browser Budget Reached (90%) | Cumulative browser time ≥ 540s | Trip safety circuit breaker | Halt new browser launches + Telegram Alert |
| Concurrent Worker Execution | DO Lock collision | First wins, second aborts immediately | Silent abort, zero duplicate submission |
