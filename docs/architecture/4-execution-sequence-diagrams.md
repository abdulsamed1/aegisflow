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
    participant BMEIA as BMEIA Portal
    participant PW as Playwright Browser Engine

    Sched->>DO: AcquireLock(job_id)
    alt Lock Denied / Already Booked
        DO-->>Sched: Lock Rejected
    else Lock Acquired
        DO-->>Sched: Lock Granted
        alt Direct HTTP POST Path
            Sched->>BMEIA: POST /HomeWeb/Scheduler (Step 3 Payload)
            alt Reference GESX-... Received
                BMEIA-->>Sched: 200 OK + Confirmation HTML
                Sched->>DO: SealLock(job_id) [BOOKED]
            else Unconfirmed / Captcha Failure
                Sched->>PW: Launch Fallback Browser Session
                PW->>BMEIA: Fill PII DOM & Submit
                PW-->>Sched: Submission Result
                Sched->>DO: ReleaseLock(job_id)
            end
        end
    end
```

> The dual-engine architecture prioritizes ultra-low latency direct HTTP POST execution (~200ms), falling back automatically to Cloudflare Playwright browser automation if HTTP direct submission requires browser interaction.

---
