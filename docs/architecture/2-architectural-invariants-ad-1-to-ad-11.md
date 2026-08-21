# 2. Architectural Invariants (AD-1 to AD-11)

| ID | Title | Rule & Binding | Prevents |
|---|---|---|---|
| **AD-1** | Storage Tier Classification | D1 = Relational source of truth & audit logs.<br>Durable Objects = Atomic job locks & state mutation.<br>KV = Temporary session cookies (`storageState`). | Data corruption & split-brain locks |
| **AD-2** | Consolidated Worker Topology | Single Cloudflare Worker combining HTTP handlers, Cron triggers, and Browser bindings. Service bindings deferred until needed. | Premature microservice abstraction bloat |
| **AD-3** | Application-Level PII Encryption | All PII fields (`passport_number`, `phone`, `email`, `first_name`, `last_name`) encrypted using AES-256-GCM before writing to D1. Key in Worker Secret `PII_ENCRYPTION_KEY`. | Unencrypted PII leaks in database backups |
| **AD-4** | Single-POST Availability Scanner | Availability checks bypass UI steps, executing `POST /HomeWeb/Scheduler` directly with form params. | Excessive browser time budget consumption |
| **AD-5** | Atomic Job Lock Actor | Every client job binds to a dedicated Durable Object (`JobLockDO`). Booking attempts require DO lock acquisition before browser launch. | Double-booking race conditions |
| **AD-6** | ~~Mandatory Dry-Run Safety~~ — **RETIRED 2026-08-21** | `DRY_RUN` removed per operator request; system now executes live booking only. | — |
| **AD-7** | Outstanding Workload Scheduler | Queue prioritization orders active jobs strictly by `last_check ASC` (oldest outstanding check first). | Unfair starvation of older client jobs |
| **AD-8** | Edge Origin Proximity Placement | Worker `placement = { mode = "smart" }` configured in `wrangler.toml` to colocate execution near BMEIA origin (Vienna/Frankfurt). `[verify: smart placement availability on Workers Free plan before deploy]` | High cross-continental network latency RTT |
| **AD-9** | Pre-Serialized Payloads (Scanner) | Scanner payload `Language/Office/CalendarId/PersonCount/Monday/Command` is pre-serialized via `buildPreSerializedPayload` (FR-5). Booking payload `buildStep3DetailsPayload` now maps 31 real portal names (`Lastname/Firstname/DateOfBirth/TraveldocumentNumber/Sex/Postcode/Telephone/DSGVOAccepted/BDC_*/CaptchaText/Token/StartTime`) per London evidence; used only by Playwright wizard — direct HTTP booking is dead (FR-7). | Runtime string building & allocation latency |
| **AD-10** | Concurrent Multi-Candidate Parallel Fan-Out | All jobs and all 8-week horizon scans are executed simultaneously using `Promise.all`. The system acts on the first successful slot response. | Sequential candidate submission delays & latency |
| **AD-11** | Global Cairo Operating Window & Rolling Horizon | All ACTIVE jobs scan only inside **07:00–18:00 Cairo time, every day (Friday included)** — the tick exits immediately outside the window. Each scan covers the **current week + 7 forward weeks** (8-week horizon, global constant in `src/scheduler.ts`). No per-client schedule fields exist; `jobs.start_date/end_date/allowed_days/preferred_time_*` are legacy columns the scheduler never reads. | Out-of-window portal load; unbounded scan fan-out; per-client rule drift |

---
