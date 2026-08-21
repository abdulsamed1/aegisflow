# Epic 2: Single-POST Availability Scanner & Fair Scheduler

## Story 2.1: Fast Single-POST Scanner
- **As a** Scanner Engine,  
- **I want to** query `POST /HomeWeb/Scheduler` directly with form parameters,  
- **So that** availability is scanned in under 300ms without loading heavy UI pages.

### Acceptance Criteria:
1. POST request sent with verified params (`Office=KAIRO`, `CalendarId`, `Monday`, `Command=Next`) and warmed session cookies (`AspxAutoDetectCookieSupport=1` + `ASP.NET_SessionId` persisted in KV).
2. HTML response parser implements the 3-state G0 contract: `message-error` → NO_SLOTS; scheduler page with non-empty week grid → SLOTS; anything else → UNKNOWN (never a slot).
3. Total scan latency averages < 500ms per request (measured baseline ~270ms).

---

## Story 2.2: Global-Window Fair Queue Scheduler (D5 amended 2026-08-20)
- **As a** Scheduler,  
- **I want to** run every minute inside the global 07:00–18:00 Cairo window (daily, Friday included) and pick up to 3 active jobs by oldest `last_check` timestamp, scanning a rolling 8-week horizon,  
- **So that** any slot appearing inside the window is captured and checks are distributed fairly.

### Acceptance Criteria:
1. Cron Trigger fires every minute; execution is gated to the global 07:00–18:00 Cairo window (daily, Friday included) — outside the window the tick exits immediately.
2. Scheduler queries D1 for enabled `ACTIVE` jobs ordered strictly by `last_check ASC`, processing up to 3 per tick.
3. Each job's scan covers the current week plus the next 7 weeks (rolling 8-week horizon, global constant — replaces the removed `start_date`–`end_date` per-client window).
4. Candidates with older checks are processed first, preventing backlog starvation.
5. No date-based expiry: a request stays `ACTIVE` until `BOOKED` or operator cancellation (D8).

---

## Story 2.3: Exponential Backoff & Circuit Breaker
- **As a** System,  
- **I want to** apply backoff on transient errors and monitor daily browser time,  
- **So that** portal rate-limits or system errors do not drain resources.

### Acceptance Criteria:
1. Failures (`TEMPORARY_ERROR` / `BOOKING_FAILED`) set `backoff_until` timestamp using exponential backoff (2, 4, 8, 16, 32, max 60 mins).
2. Cumulative browser seconds are tracked in `daily_metrics`.
3. System trips safety circuit breaker at 540 seconds (90% of 600s daily budget) and alerts operator.

---
