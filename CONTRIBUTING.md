# Contributing to AegisFlow

Thank you for your interest in contributing to AegisFlow! This project is an edge-native consular appointment automation platform built on Cloudflare Workers, TypeScript, D1 (SQLite), Durable Objects, and Workers AI.

---

## Code of Conduct

All contributors and maintainers are expected to maintain a respectful, professional, and harassment-free environment.

---

## Development Setup

### Prerequisites

- **Node.js**: v20.x or higher (uses native `node:test` runner)
- **npm**: v10.x or higher
- **Wrangler**: v3.72.0 or higher (`npm install -g wrangler` or via local dev dependencies)
- **Cloudflare Account**: with Workers, D1, KV, Durable Objects, and Browser Rendering enabled.

### Local Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/abdulsamed1/aegisflow.git
   cd aegisflow
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure local environment variables**:
   ```bash
   cp .dev.vars.example .dev.vars
   ```
   Edit `.dev.vars` with your test encryption key (e.g. `openssl rand -hex 16`) and optional test tokens.

4. **Verify TypeScript compilation**:
   ```bash
   npm run typecheck
   ```

5. **Run the comprehensive test suite**:
   ```bash
   npm test
   ```

---

## Architectural Guardrails & Invariants

When contributing code, you must adhere to the following architectural rules:

1. **Zero Hardcoded Secrets**:
   - Never commit API keys, bot tokens, or encryption keys. All sensitive configuration must be sourced through environment bindings (`env.*`).

2. **Zero-Trust PII Encryption (AD-3)**:
   - Sensitive client fields must always be encrypted via `encryptClientData()` before writing to D1 and decrypted via `decryptClientData()` only when strictly needed in memory.

3. **Dashboard Inline JS Rule**:
   - The admin dashboard (`getAdminHTML()` in `src/index.ts`) is rendered within backtick template strings. **NEVER** use `\'` inside this template, as it collapses into `'` in served HTML and causes browser syntax errors. Client-side template literals must be escaped as `\${`.

4. **Edge CPU Budget (<10ms Free Tier)**:
   - Read paths (such as `/api/daily-report`, `/api/logs`, `/api/status`) must avoid full-table scans. All timestamp and status filters must leverage SQLite indexes. Avoid constructing per-row formatters or redundant JSON parsing.

5. **Test-Driven Verification**:
   - Every bug fix or new feature must be accompanied by automated tests in `test/`. The test suite uses the built-in Node.js test runner (`node --import tsx --test`).

---

## Pull Request Workflow

1. **Create a branch**:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** adhering to the project's formatting and architectural conventions.

3. **Run verification gates**:
   ```bash
   npm run typecheck
   npm test
   ```
   Ensure all tests pass with zero failures.

4. **Commit with clear commit messages**:
   Use conventional commits where possible (e.g., `feat: ...`, `fix: ...`, `refactor: ...`, `docs: ...`).

5. **Push and open a Pull Request**:
   Describe the motivation, implementation details, and test evidence in your PR description.
