# Technical Architecture Specification — BMEIA Appointment Automation (aegisflow)

## Table of Contents

- [Technical Architecture Specification — BMEIA Appointment Automation (aegisflow)](#table-of-contents)
  - [1. System Topology Architecture](./1-system-topology-architecture.md)
  - [2. Architectural Invariants (AD-1 to AD-11)](./2-architectural-invariants-ad-1-to-ad-11.md)
  - [3. Database Schema (Cloudflare D1)](./3-database-schema-cloudflare-d1.md)
  - [4. Execution Sequence Diagrams](./4-execution-sequence-diagrams.md)
    - [4.1 Scheduled Availability Check (Scanner Flow)](./4-execution-sequence-diagrams.md#41-scheduled-availability-check-scanner-flow)
    - [4.2 Booking Flow (Direct HTTP Mode & Playwright Fallback)](./4-execution-sequence-diagrams.md#42-booking-flow-direct-http-mode-playwright-fallback)
  - [5. Security Architecture & Encryption Details](./5-security-architecture-encryption-details.md)
    - [5.1 AES-256-GCM Encryption Helper Specification](./5-security-architecture-encryption-details.md#51-aes-256-gcm-encryption-helper-specification)
    - [5.2 Dual-Layer Authentication — Audited 2026-08-21 (src/index.ts:36-125)](./5-security-architecture-encryption-details.md#52-dual-layer-authentication-audited-2026-08-21-srcindexts36-125)
  - [6. Error & Failure Modes Matrix](./6-error-failure-modes-matrix.md)
