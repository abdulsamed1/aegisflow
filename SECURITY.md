# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

## Security Architecture

AegisFlow is engineered with a **zero-trust security posture** specifically designed to handle sensitive applicant personally identifiable information (PII) at the edge:

1. **Application-Level PII Encryption at Rest (AD-3)**:
   - All sensitive applicant fields (`first_name`, `last_name`, `passport_number`, `email`, `phone`, `family_name_at_birth`, and address lines) are encrypted using **AES-256-GCM** with unique 12-byte initialization vectors (IVs) per field before writing to Cloudflare D1 (SQLite).
   - Encryption keys are loaded exclusively from Cloudflare Worker Secrets (`PII_ENCRYPTION_KEY`) at runtime via the Web Crypto API (`crypto.subtle`). Keys are never logged or stored in database tables.

2. **Distributed Double-Booking Prevention**:
   - Single distributed locks are managed via SQLite-backed Cloudflare Durable Objects (`JobLockDO`) with automatic TTL-based expiration to prevent concurrent race conditions across global edge data centers.

3. **Ephemeral In-Memory Lifecycle**:
   - Client records are decrypted only in memory during active booking execution and immediately discarded after form submission.

4. **Zero Hardcoded Secrets Policy**:
   - No production secrets, tokens, or encryption keys are committed to the codebase. All sensitive values are managed through Cloudflare Secrets and `.dev.vars` (which is strictly gitignored).

## Reporting a Vulnerability
 
If you discover a security vulnerability or potential sensitive data leak in AegisFlow, please do **NOT** open a public issue.
 
Instead, please report it privately through GitHub:
- Submit a report via [GitHub Security Advisory](https://github.com/abdulsamed1/aegisflow/security/advisories/new)
- Include:
  - Description of the vulnerability
  - Step-by-step reproduction instructions or proof-of-concept
  - Potential impact assessment
 
Reports are reviewed promptly, followed by updates as the issue is investigated and remediated.
