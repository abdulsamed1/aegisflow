# 4. Execution Sequence Diagrams

## 4.1 Scheduled Availability Check (Scanner Flow)

```mermaid
sequenceDiagram
    autonumber
    participant Cron as Worker Cron (1 min)
    participant Sched as Scheduler Engine
    participant D1 as D1 Database
    participant BMEIA as BMEIA Portal API

    Cron->>Sched: Execute Scheduled Check (07:00-18:00 Cairo, daily)
    Sched->>Sched: Scan jobs by oldest last_check (up to 3/tick)
    Sched->>D1: Fetch next job (enabled=1, status='ACTIVE', last_check ASC)
    D1-->>Sched: Job Records
    Sched->>BMEIA: Pre-fetch Session Cookie (Once per tick)
    Sched->>BMEIA: Promise.all() POST /HomeWeb/Scheduler (All jobs & weeks in parallel)
    BMEIA-->>Sched: HTML Responses (measured ~120-270ms)
    alt Response contains 'message-error'
        Sched->>D1: ctx.waitUntil() Insert audit log (NO_APPOINTMENT)
    else Grid content found (SLOTS)
        Sched->>D1: ctx.waitUntil() Insert audit log (APPOINTMENT_FOUND)
        Sched->>Sched: Transition Job to 'BOOKING' & Trigger Booking Flow
    else Unexpected structure
        Sched->>D1: ctx.waitUntil() Insert audit log (UNKNOWN_RESPONSE)
    end
    Note over Sched,D1: All Database Telemetry and Logging is offloaded to the background via ctx.waitUntil() to ensure zero blocking latency.
```

## 4.2 Booking Flow (Direct HTTP Mode & Playwright Fallback)

```mermaid
sequenceDiagram
    autonumber
    participant Sched as Scheduler Engine
    participant DO as JobLockDO (Durable Object)
    participant TG as Telegram Bot API
    participant BMEIA as BMEIA Portal
    participant BW as Puppeteer Browser (acquire→connect, fs-free)

    Sched->>DO: AcquireLock(job_id)
    alt Lock Denied / Already Booked
        DO-->>Sched: Lock Rejected
    else Lock Granted
        DO-->>Sched: Lock Granted
        Sched->>TG: 🚨 Arabic slot alarm (KV-deduped per job+week)
        Sched->>BMEIA: Reverify POST (slot still SLOTS?)
        alt Slot gone / UNKNOWN
            Sched->>TG: ⚠️ SLOT_GONE stand-down
            Sched->>DO: ReleaseLock(job_id)
        else Slot verified
            Sched->>TG: 🤖 Wizard launching (attempt N)
            Sched->>BW: launchBrowser() after 20s throttle gate
            BW->>BMEIA: Wizard: Office→Calendar→Person→Info→Grid→Form→Captcha→Submit
            alt Reference GESX-... Received
                BMEIA-->>Sched: 200 OK + Confirmation HTML
                Sched->>TG: 🎉 BOOKED + reference
                Sched->>DO: SealLock(job_id) [BOOKED]
            else Attempt failed, slot still SLOTS, breaker clear
                Sched->>TG: 🔁 RETRY notice (attempt 1 only)
                Sched->>BW: Second launch (bounded: one same-tick retry)
            end
        end
        alt Both attempts failed (or no retry)
            Sched->>TG: ❌ FAILED + never-parked notice
            Sched->>DO: ReleaseLock(job_id)
            Note over Sched,DO: Requeue ACTIVE with backoff_until = NULL (never-park 2026-09-11) — retries next tick
        end
    end
```

> Single-engine architecture since 2026-09-11: direct HTTP submission is retired (FR-7) and the wizard launches exclusively via `@cloudflare/puppeteer` (`launchBrowser`), after Playwright's `fs.mkdtemp` crash made every launch fail. Billed browser seconds exclude the 20s throttle-gate wait (`workStartTime`). Operator applies manually in parallel off the Arabic slot alarm.

---
