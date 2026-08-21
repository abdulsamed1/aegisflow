# Epic 1: Foundation & Data Infrastructure

## Story 1.1: Database Schema & PII Encryption
- **As an** Engineer,  
- **I want to** initialize the Cloudflare D1 database schema and Web Crypto AES-256-GCM encryption module,  
- **So that** all candidate client PII is securely encrypted at rest before hitting the database.

### Acceptance Criteria:
1. D1 migration script creates `clients`, `jobs`, `audit_logs`, and `daily_metrics` tables with indexes.
2. `encryptPII(text, key)` and `decryptPII(ciphertext, key)` helpers use Web Crypto API `AES-GCM` with random 12-byte IVs.
3. Unencrypted passport numbers or contact details never land in D1 storage or log output.

---

## Story 1.2: Client Candidate & Job CRUD API
- **As an** Operator,  
- **I want to** create, update, list, and delete client candidate profiles and booking jobs via HTTP endpoints,  
- **So that** candidate data is managed accurately.

### Acceptance Criteria:
1. REST endpoints: `GET /api/clients`, `POST /api/clients`, `PUT /api/clients/:id`, `DELETE /api/clients/:id`.
2. Job lifecycle endpoints: `POST /api/jobs/:id/activate`, `POST /api/jobs/:id/pause`, `POST /api/jobs/:id/cancel`.
3. Client creation accepts the complete BMEIA identity profile (birth, address, passport-issue fields — D8/FR-1 amendment 2026-08-20), encrypted per the field-class convention.
4. System rejects requests attempting to create more than 10 active jobs.

---

## Story 1.3: Structural Validation Engine
- **As a** System,  
- **I want to** validate candidate PII before allowing job activation,  
- **So that** malformed candidate data does not waste availability scans.

### Acceptance Criteria:
1. Passport expiry rule applied per operator configuration. `[ASSUMPTION: the 6-month rule must be confirmed against the official requirements list before it becomes a hard gate]`
2. All required client fields (identity, birth, address, passport-issue data — 2026-08-20 amendment) must be present and non-empty before activation.
3. Invalid data transitions record to `VALIDATION_ERROR` with human-readable error messages.

---
