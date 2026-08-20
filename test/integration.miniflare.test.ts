import test, { before, after } from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { Miniflare } from "miniflare";
import { SCHEDULER_PICK_QUERY } from "../src/scheduler";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_PATH = join(PROJECT_ROOT, ".tmp-bundle/index.js");
const TEST_SECRET = "integration-test-key-32chars!";
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    first_name_enc TEXT NOT NULL,
    last_name_enc TEXT NOT NULL,
    gender TEXT CHECK (gender IN ('Male', 'Female')),
    dob TEXT NOT NULL,
    nationality TEXT NOT NULL,
    passport_number_enc TEXT NOT NULL,
    passport_expiry TEXT NOT NULL,
    email_enc TEXT NOT NULL,
    phone_enc TEXT NOT NULL,
    category TEXT CHECK (category IN ('Bachelor', 'Master_PhD')) NOT NULL,
    calendar_id INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    enabled INTEGER DEFAULT 0,
    status TEXT CHECK (status IN (
        'DRAFT', 'VALIDATION_ERROR', 'READY', 'ACTIVE',
        'SEARCHING', 'BOOKING', 'BOOKED', 'BOOKING_FAILED',
        'TEMPORARY_ERROR', 'PORTAL_ERROR', 'CANCELLED', 'EXPIRED'
    )) DEFAULT 'DRAFT',
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    allowed_days TEXT NOT NULL,
    preferred_time_start TEXT DEFAULT '08:00',
    preferred_time_end TEXT DEFAULT '16:00',
    check_count INTEGER DEFAULT 0,
    last_check TIMESTAMP,
    last_error_code TEXT,
    backoff_until TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT REFERENCES jobs(id),
    client_id TEXT REFERENCES clients(id),
    event_type TEXT NOT NULL,
    duration_ms INTEGER,
    error_code TEXT,
    details TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS daily_metrics (
    date TEXT PRIMARY KEY,
    total_checks INTEGER DEFAULT 0,
    total_browser_seconds REAL DEFAULT 0.0,
    slots_found INTEGER DEFAULT 0,
    bookings_completed INTEGER DEFAULT 0,
    budget_alert_sent INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jobs_scheduler ON jobs(enabled, status, backoff_until, last_check);
CREATE INDEX IF NOT EXISTS idx_audit_job ON audit_logs(job_id, created_at);
`;

let instances: Miniflare[] = [];

async function startWorker(options?: { durablesPersist?: string; noSecret?: boolean }) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: BUNDLE_PATH,
    compatibilityDate: "2025-09-15",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { JOB_LOCK: "JobLockDO" },
    kvNamespaces: { SESSION_KV: "session-kv" },
    d1Databases: { DB: "app-db" },
    durableObjectsPersist: options?.durablesPersist,
    bindings: options?.noSecret
      ? { DRY_RUN: "true" }
      : { DRY_RUN: "true", PII_ENCRYPTION_KEY: TEST_SECRET }
  });
  instances.push(mf);

  const db = await mf.getD1Database("DB");
  for (const stmt of SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean)) {
    await db.prepare(stmt).run();
  }
  return mf;
}

before(() => {
  execSync("npx wrangler deploy --dry-run --outdir .tmp-bundle", {
    cwd: PROJECT_ROOT,
    stdio: "pipe",
    timeout: 120_000
  });
  assert.ok(
    require("node:fs").existsSync(BUNDLE_PATH),
    "Bundle must exist at .tmp-bundle/index.js"
  );
});

after(async () => {
  for (const mf of instances) {
    try { await mf.dispose(); } catch {}
  }
  instances = [];
});

test("Integration: client creation encrypts PII at rest and returns masked data on read", async () => {
  const mf = await startWorker();

  const createRes = await mf.dispatchFetch("https://opran.local/api/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      firstName: "Ahmed", lastName: "Hassan", category: "Bachelor",
      passportNumber: "A12345678", passportExpiry: "2030-01-01",
      dob: "1990-05-05", gender: "Male", nationality: "Egyptian",
      email: "ahmed@example.com", phone: "+201000000000"
    })
  });
  assert.strictEqual(createRes.status, 201);
  const created = await createRes.json() as any;
  assert.ok(created.clientId, "clientId must be returned");
  assert.ok(created.jobId, "jobId must be returned");

  const db = await mf.getD1Database("DB");
  const clientRow = await db.prepare("SELECT * FROM clients WHERE id = ?").bind(created.clientId).first<any>();
  assert.ok(clientRow, "Client row must exist in D1");
  assert.notStrictEqual(clientRow.passport_number_enc, "A12345678", "DB must store ciphertext, never plaintext passport");
  assert.notStrictEqual(clientRow.first_name_enc, "Ahmed", "DB must store ciphertext first name");
  assert.notStrictEqual(clientRow.email_enc, "ahmed@example.com", "DB must store ciphertext email");
  assert.strictEqual(clientRow.category, "Bachelor");
  assert.strictEqual(clientRow.calendar_id, 44281520, "Bachelor must map to calendar 44281520");

  const jobRow = await db.prepare("SELECT * FROM jobs WHERE id = ?").bind(created.jobId).first<any>();
  assert.ok(jobRow, "Job row must be auto-created");
  assert.strictEqual(jobRow.enabled, 1);
  assert.strictEqual(jobRow.status, "ACTIVE");

  const listRes = await mf.dispatchFetch("https://opran.local/api/clients");
  assert.strictEqual(listRes.status, 200);
  const clients = await listRes.json() as any[];
  assert.strictEqual(clients.length, 1);
  assert.strictEqual(clients[0].firstName, "Ahmed", "GET must decrypt first name");
  assert.strictEqual(clients[0].lastName, "Hassan", "GET must decrypt last name");
  assert.strictEqual(clients[0].maskedPassport, "A1****78", "GET must return masked passport");
  assert.ok(!JSON.stringify(clients).includes("A12345678"), "Raw passport must never appear in API output");
});

test("Integration: missing PII_ENCRYPTION_KEY fails closed with 500", async () => {
  const mf = await startWorker({ noSecret: true });

  const res = await mf.dispatchFetch("https://opran.local/api/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ firstName: "A", lastName: "B", passportNumber: "X1" })
  });
  assert.strictEqual(res.status, 500);
  const body = await res.json() as any;
  assert.match(body.error, /PII_ENCRYPTION_KEY/);

  const listRes = await mf.dispatchFetch("https://opran.local/api/clients");
  assert.strictEqual(listRes.status, 500, "GET must also fail closed without the secret");
});

test("Integration: scheduler query returns oldest-outstanding jobs, excludes backoff jobs (AD-7 fairness)", async () => {
  const mf = await startWorker();
  const db = await mf.getD1Database("DB");

  await db.prepare(
    `INSERT INTO clients (id, first_name_enc, last_name_enc, gender, dob, nationality, passport_number_enc, passport_expiry, email_enc, phone_enc, category, calendar_id)
     VALUES ('c1','x','x','Male','1990-01-01','Egyptian','x','2030-01-01','x','x','Bachelor',44281520)`
  ).run();
  await db.prepare(
    `INSERT INTO clients (id, first_name_enc, last_name_enc, gender, dob, nationality, passport_number_enc, passport_expiry, email_enc, phone_enc, category, calendar_id)
     VALUES ('c2','x','x','Male','1990-01-01','Egyptian','x','2030-01-01','x','x','Bachelor',44281520)`
  ).run();
  await db.prepare(
    `INSERT INTO clients (id, first_name_enc, last_name_enc, gender, dob, nationality, passport_number_enc, passport_expiry, email_enc, phone_enc, category, calendar_id)
     VALUES ('c3','x','x','Male','1990-01-01','Egyptian','x','2030-01-01','x','x','Bachelor',44281520)`
  ).run();
  await db.prepare(
    `INSERT INTO clients (id, first_name_enc, last_name_enc, gender, dob, nationality, passport_number_enc, passport_expiry, email_enc, phone_enc, category, calendar_id)
     VALUES ('c4','x','x','Male','1990-01-01','Egyptian','x','2030-01-01','x','x','Bachelor',44281520)`
  ).run();

  const insertJob = (id: string, clientId: string, lastCheck: string, backoffUntil: string | null) =>
    db.prepare(
      `INSERT INTO jobs (id, client_id, enabled, status, start_date, end_date, allowed_days, last_check, backoff_until)
       VALUES (?, ?, 1, 'ACTIVE', '2026-09-01', '2026-10-31', '["Monday"]', ?, ?)`
    ).bind(id, clientId, lastCheck, backoffUntil).run();

  await insertJob("j_oldest", "c1", "2026-08-10 00:00:00", null);
  await insertJob("j_middle", "c2", "2026-08-11 00:00:00", null);
  await insertJob("j_newest", "c3", "2026-08-12 00:00:00", null);
  await insertJob("j_backoff", "c4", "2026-08-09 00:00:00", "2999-01-01 00:00:00");

  const { results } = await db.prepare(SCHEDULER_PICK_QUERY).all<any>();
  assert.strictEqual(results.length, 3, "LIMIT 3 must apply");
  assert.deepStrictEqual(
    results.map((r: any) => r.id),
    ["j_oldest", "j_middle", "j_newest"],
    "Oldest-outstanding must win; backoff job (oldest but cooling down) must be excluded"
  );
});

test("Integration: Durable Object lock lifecycle (acquire, reject, release, seal)", async () => {
  const mf = await startWorker();
  const ns = await mf.getDurableObjectNamespace("JOB_LOCK");
  const id = ns.newUniqueId();
  const stub = ns.get(id);

  const r1 = await stub.fetch("https://lock/acquire");
  assert.strictEqual(r1.status, 200, "First acquire must succeed");
  assert.strictEqual((await r1.json() as any).acquired, true);

  const r2 = await stub.fetch("https://lock/acquire");
  assert.strictEqual(r2.status, 409, "Concurrent acquire must be rejected");
  assert.match(await r2.text(), /held by another task/);

  const r3 = await stub.fetch("https://lock/release");
  assert.strictEqual(r3.status, 200);
  assert.strictEqual((await r3.json() as any).released, true);

  const r4 = await stub.fetch("https://lock/acquire");
  assert.strictEqual(r4.status, 200, "Acquire after release must succeed");

  const r5 = await stub.fetch("https://lock/seal");
  assert.strictEqual(r5.status, 200);
  assert.strictEqual((await r5.json() as any).sealed, true);

  const r6 = await stub.fetch("https://lock/acquire");
  assert.strictEqual(r6.status, 409, "Sealed (BOOKED) lock must never be re-acquired");
  assert.match(await r6.text(), /permanently sealed/);
});

test("Integration: stale lock (crashed execution) expires and allows takeover after TTL", async () => {
  const persistDir = mkdtempSync(join(tmpdir(), "opran-do-"));

  const mf1 = await startWorker({ durablesPersist: persistDir });
  const ns1 = await mf1.getDurableObjectNamespace("JOB_LOCK");
  const stub1 = ns1.get(ns1.idFromName("job_x"));
  const r1 = await stub1.fetch("https://lock/acquire");
  assert.strictEqual(r1.status, 200, "Sandbox acquire must succeed");
  await mf1.dispose();
  instances = instances.filter((i) => i !== mf1);
  await new Promise((r) => setTimeout(r, 300));

  const dbFile = execSync(
    `find ${persistDir} -name "*.sqlite" ! -name "*-wal" ! -name "*-shm" | head -1`
  ).toString().trim();
  assert.ok(dbFile, "Persisted DO sqlite file must exist");

  const sqlite = new DatabaseSync(dbFile);
  sqlite.prepare("UPDATE _cf_KV SET value = ? WHERE key = 'locked_at'")
    .run(serialize(Date.now() - 6 * 60 * 1000));
  sqlite.close();
  execSync(`rm -f "${dbFile}-wal" "${dbFile}-shm"`);

  const mf2 = await startWorker({ durablesPersist: persistDir });
  const ns2 = await mf2.getDurableObjectNamespace("JOB_LOCK");
  const stub2 = ns2.get(ns2.idFromName("job_x"));
  const r2 = await stub2.fetch("https://lock/acquire");
  assert.strictEqual(r2.status, 200, "Stale lock must be taken over after TTL expiry");
  assert.strictEqual((await r2.json() as any).acquired, true);

  rmSync(persistDir, { recursive: true, force: true });
});