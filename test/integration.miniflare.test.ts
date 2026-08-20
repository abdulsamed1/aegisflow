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
    family_name_at_birth_enc TEXT NOT NULL,
    place_of_birth TEXT NOT NULL,
    country_of_birth TEXT NOT NULL,
    nationality_at_birth TEXT NOT NULL,
    address_street_enc TEXT NOT NULL,
    address_postal_code_enc TEXT NOT NULL,
    address_city_enc TEXT NOT NULL,
    passport_issue_date TEXT NOT NULL,
    passport_issuing_country TEXT NOT NULL,
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
    preferred_time_start TEXT DEFAULT '07:00',
    preferred_time_end TEXT DEFAULT '18:00',
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
      familyNameAtBirth: "Hassan", placeOfBirth: "Cairo", countryOfBirth: "Egypt",
      nationalityAtBirth: "Egyptian", street: "15 Tahrir Square", postalCode: "11511",
      city: "Cairo", passportIssueDate: "2018-06-15", passportIssuingCountry: "Egypt",
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
  assert.notStrictEqual(clientRow.family_name_at_birth_enc, "Hassan", "Family name at birth must be encrypted");
  assert.notStrictEqual(clientRow.address_street_enc, "15 Tahrir Square", "Street must be encrypted");
  assert.notStrictEqual(clientRow.address_postal_code_enc, "11511", "Postal code must be encrypted");
  assert.notStrictEqual(clientRow.address_city_enc, "Cairo", "City must be encrypted");
  assert.strictEqual(clientRow.place_of_birth, "Cairo", "Place of birth stays plaintext per field-class convention");
  assert.strictEqual(clientRow.passport_issue_date, "2018-06-15", "Passport issue date stays plaintext");
  assert.strictEqual(clientRow.category, "Bachelor");
  assert.strictEqual(clientRow.calendar_id, 44281520, "Bachelor must map to calendar 44281520");

  const jobRow = await db.prepare("SELECT * FROM jobs WHERE id = ?").bind(created.jobId).first<any>();
  assert.ok(jobRow, "Job row must be auto-created");
  assert.strictEqual(jobRow.enabled, 1);
  assert.strictEqual(jobRow.status, "ACTIVE");
  assert.strictEqual(jobRow.preferred_time_start, "07:00", "Legacy column must carry the global window start");
  assert.strictEqual(jobRow.preferred_time_end, "18:00", "Legacy column must carry the global window end");
  const allowedDays = JSON.parse(jobRow.allowed_days);
  assert.strictEqual(allowedDays.length, 7, "Legacy allowed_days must carry all 7 days");

  const listRes = await mf.dispatchFetch("https://opran.local/api/clients");
  assert.strictEqual(listRes.status, 200);
  const clients = await listRes.json() as any[];
  assert.strictEqual(clients.length, 1);
  assert.strictEqual(clients[0].firstName, "Ahmed", "GET must decrypt first name");
  assert.strictEqual(clients[0].lastName, "Hassan", "GET must decrypt last name");
  assert.strictEqual(clients[0].familyNameAtBirth, "Hassan", "GET must decrypt family name at birth");
  assert.strictEqual(clients[0].street, "15 Tahrir Square", "GET must decrypt street");
  assert.strictEqual(clients[0].placeOfBirth, "Cairo", "GET must return plaintext-class field");
  assert.strictEqual(clients[0].maskedPassport, "A1****78", "GET must return masked passport");
  assert.ok(!JSON.stringify(clients).includes("A12345678"), "Raw passport must never appear in API output");
  assert.strictEqual(clients[0].email, "ahmed@example.com", "GET must decrypt email for edit prefill");
  assert.strictEqual(clients[0].phone, "+201000000000", "GET must decrypt phone for edit prefill");
  assert.strictEqual(clients[0].passportExpiry, "2030-01-01", "GET must return passport expiry for edit prefill");
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

  const insertClient = (id: string) =>
    db.prepare(
      `INSERT INTO clients (id, first_name_enc, last_name_enc, gender, dob, nationality, passport_number_enc, passport_expiry, email_enc, phone_enc, family_name_at_birth_enc, place_of_birth, country_of_birth, nationality_at_birth, address_street_enc, address_postal_code_enc, address_city_enc, passport_issue_date, passport_issuing_country, category, calendar_id)
       VALUES (?, 'x', 'x', 'Male', '1990-01-01', 'Egyptian', 'x', '2030-01-01', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', '2018-01-01', 'Egypt', 'Bachelor', 44281520)`
    ).bind(id).run();

  await insertClient("c1");
  await insertClient("c2");
  await insertClient("c3");
  await insertClient("c4");

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
  assert.ok(
    !("start_date" in results[0]) && !("end_date" in results[0]),
    "Scheduler must never read legacy per-client date columns (D8/AD-11)"
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

test("Integration: PUT /api/clients/:id round-trips updates, recomputes calendar, keeps passport on empty", async () => {
  const mf = await startWorker();

  const createRes = await mf.dispatchFetch("https://opran.local/api/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      firstName: "Ahmed", lastName: "Hassan", category: "Bachelor",
      familyNameAtBirth: "Hassan", placeOfBirth: "Cairo", countryOfBirth: "Egypt",
      nationalityAtBirth: "Egyptian", street: "15 Tahrir Square", postalCode: "11511",
      city: "Cairo", passportIssueDate: "2018-06-15", passportIssuingCountry: "Egypt",
      passportNumber: "A12345678", passportExpiry: "2030-01-01",
      dob: "1990-05-05", gender: "Male", nationality: "Egyptian",
      email: "ahmed@example.com", phone: "+201000000000"
    })
  });
  const created = await createRes.json() as any;

  const db = await mf.getD1Database("DB");
  const before = await db.prepare("SELECT passport_number_enc, calendar_id FROM clients WHERE id = ?")
    .bind(created.clientId).first<any>();
  assert.strictEqual(before.calendar_id, 44281520, "Bachelor must map to 44281520 before update");

  const putRes = await mf.dispatchFetch(`https://opran.local/api/clients/${created.clientId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      firstName: "Khaled", lastName: "Hassan", category: "Master_PhD",
      familyNameAtBirth: "Hassan", placeOfBirth: "Giza", countryOfBirth: "Egypt",
      nationalityAtBirth: "Egyptian", street: "9 Nile Street", postalCode: "12211",
      city: "Giza", passportIssueDate: "2018-06-15", passportIssuingCountry: "Egypt",
      passportNumber: "", passportExpiry: "2031-06-30",
      dob: "1990-05-05", gender: "Male", nationality: "Egyptian",
      email: "khaled@example.com", phone: "+201000000001"
    })
  });
  assert.strictEqual(putRes.status, 200, await putRes.text());

  const row = await db.prepare("SELECT * FROM clients WHERE id = ?").bind(created.clientId).first<any>();
  assert.strictEqual(row.category, "Master_PhD", "Category must update");
  assert.strictEqual(row.calendar_id, 44279679, "calendar_id must follow the new category");
  assert.strictEqual(row.passport_number_enc, before.passport_number_enc, "Empty passport must keep existing ciphertext");
  assert.notStrictEqual(row.first_name_enc, "Khaled", "First name must be stored encrypted");
  assert.notStrictEqual(row.email_enc, "khaled@example.com", "Email must be stored encrypted");
  assert.strictEqual(row.place_of_birth, "Giza", "Plaintext-class field must update directly");
  assert.strictEqual(row.passport_expiry, "2031-06-30", "Passport expiry must update");

  const jobRow = await db.prepare("SELECT * FROM jobs WHERE client_id = ?").bind(created.clientId).first<any>();
  assert.ok(jobRow, "Job must survive the update");
  assert.strictEqual(jobRow.status, "ACTIVE", "Update must not touch job state");

  const listRes = await mf.dispatchFetch("https://opran.local/api/clients");
  const clients = await listRes.json() as any[];
  assert.strictEqual(clients[0].firstName, "Khaled", "GET must decrypt the updated first name");
  assert.strictEqual(clients[0].street, "9 Nile Street", "GET must decrypt the updated street");
});
test("Integration: DELETE /api/clients/:id cascades job and writes audit row", async () => {
  const mf = await startWorker();
  const createRes = await mf.dispatchFetch("https://opran.local/api/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      firstName: "Ahmed", lastName: "Hassan", category: "Bachelor",
      familyNameAtBirth: "Hassan", placeOfBirth: "Cairo", countryOfBirth: "Egypt",
      nationalityAtBirth: "Egyptian", street: "15 Tahrir Square", postalCode: "11511",
      city: "Cairo", passportIssueDate: "2018-06-15", passportIssuingCountry: "Egypt",
      passportNumber: "A12345678", passportExpiry: "2030-01-01",
      dob: "1990-05-05", gender: "Male", nationality: "Egyptian",
      email: "ahmed@example.com", phone: "+201000000000"
    })
  });
  const created = await createRes.json() as any;

  const delRes = await mf.dispatchFetch(`https://opran.local/api/clients/${created.clientId}`, {
    method: "DELETE"
  });
  assert.strictEqual(delRes.status, 200, await delRes.text());

  const db = await mf.getD1Database("DB");
  const clientRow = await db.prepare("SELECT * FROM clients WHERE id = ?").bind(created.clientId).first<any>();
  assert.strictEqual(clientRow, null, "Client row must be gone");
  const jobRow = await db.prepare("SELECT * FROM jobs WHERE client_id = ?").bind(created.clientId).first<any>();
  assert.strictEqual(jobRow, null, "Job must cascade-delete");
  const audit = await db.prepare("SELECT * FROM audit_logs WHERE event_type = 'CLIENT_DELETED' ORDER BY id DESC LIMIT 1").first<any>();
  assert.ok(audit, "Audit row must exist");
  assert.strictEqual(audit.details, created.clientId, "Audit details must carry the deleted client id");
});

test("Integration: DELETE /api/clients/:id returns 403 for BOOKED job", async () => {
  const mf = await startWorker();
  const createRes = await mf.dispatchFetch("https://opran.local/api/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      firstName: "Ahmed", lastName: "Hassan", category: "Bachelor",
      familyNameAtBirth: "Hassan", placeOfBirth: "Cairo", countryOfBirth: "Egypt",
      nationalityAtBirth: "Egyptian", street: "15 Tahrir Square", postalCode: "11511",
      city: "Cairo", passportIssueDate: "2018-06-15", passportIssuingCountry: "Egypt",
      passportNumber: "A12345678", passportExpiry: "2030-01-01",
      dob: "1990-05-05", gender: "Male", nationality: "Egyptian",
      email: "ahmed@example.com", phone: "+201000000000"
    })
  });
  const created = await createRes.json() as any;

  const db = await mf.getD1Database("DB");
  await db.prepare("UPDATE jobs SET status = 'BOOKED' WHERE client_id = ?").bind(created.clientId).run();

  const delRes = await mf.dispatchFetch(`https://opran.local/api/clients/${created.clientId}`, {
    method: "DELETE"
  });
  assert.strictEqual(delRes.status, 403, await delRes.text());
  const clientRow = await db.prepare("SELECT * FROM clients WHERE id = ?").bind(created.clientId).first<any>();
  assert.ok(clientRow, "BOOKED client must remain");
});
