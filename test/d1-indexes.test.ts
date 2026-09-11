import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Regression (prod 2026-09-11): daily "D1 free tier 5,000,000 rows read"
// quota emails. Measured cause: the dashboard polls /api/logs?limit=200 and
// /api/status every 10s, and both queries do ORDER BY created_at DESC LIMIT
// over audit_logs with NO usable index — prod meta showed 51,640 rows read
// per /api/logs call and 25,826 per /api/status call against 25,820 rows
// (≈670M rows/day per open tab). The fix is covering indexes; these tests
// pin the endpoint query shapes to index-backed plans so a missing index
// fails loudly instead of silently burning quota again.

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaSQL = readFileSync(path.join(here, "..", "db", "schema.sql"), "utf8");

// Exact query shapes issued by src/index.ts (LIMIT values as the app uses).
const LOGS_QUERY = "SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200";
const STATUS_QUERY =
  "SELECT job_id, client_id, event_type, details, created_at FROM audit_logs " +
  "WHERE event_type IN ('BOOKING_FAILED','SLOT_GONE_PRE_LAUNCH','PRE_SUBMIT_BLOCKED','BOOKING_RETRY') " +
  "ORDER BY created_at DESC LIMIT 5";

function seedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(schemaSQL);
  // Parent rows first: audit_logs.job_id/client_id are real FKs.
  db.prepare(
    "INSERT INTO clients (id, first_name_enc, last_name_enc, gender, dob, nationality, passport_number_enc, passport_expiry, email_enc, phone_enc, family_name_at_birth_enc, place_of_birth, country_of_birth, nationality_at_birth, address_street_enc, address_postal_code_enc, address_city_enc, passport_issue_date, passport_issuing_country, category, calendar_id) VALUES ('c_0','e','e','Male','1990-01-01','Egyptian','e','2030-01-01','e','e','e','Cairo','Egypt','Egyptian','e','e','e','2020-01-01','Egypt','Bachelor',44281520)"
  ).run();
  db.prepare(
    "INSERT INTO jobs (id, client_id, enabled, status, start_date, end_date, allowed_days) VALUES ('job_0','c_0',1,'ACTIVE','2026-09-01','2026-11-01','[]')"
  ).run();
  // 1000 rows: cost-based planner only prefers the index at realistic scale,
  // and distinct timestamps keep the ORDER BY plan deterministic.
  const ins = db.prepare(
    "INSERT INTO audit_logs (job_id, client_id, event_type, duration_ms, details, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const types = ["NO_APPOINTMENT", "UNKNOWN_RESPONSE", "APPOINTMENT_FOUND", "BOOKING_FAILED", "BOOKING_RETRY"];
  for (let i = 0; i < 1000; i++) {
    const ts = `2026-09-10 07:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`;
    ins.run("job_0", "c_0", types[i % types.length], i, "{}", ts);
  }
  return db;
}

function planUsesFullScan(db: DatabaseSync, sql: string): boolean {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
  return rows.some((r) => r.detail === "SCAN audit_logs");
}

test("D1: /api/logs query shape must not full-scan audit_logs (needs created_at index)", () => {
  const db = seedDb();
  try {
    assert.strictEqual(planUsesFullScan(db, LOGS_QUERY), false, "ORDER BY created_at DESC LIMIT must use an index, not SCAN");
  } finally {
    db.close();
  }
});

test("D1: /api/status recentFailures query shape must not full-scan audit_logs", () => {
  const db = seedDb();
  try {
    assert.strictEqual(planUsesFullScan(db, STATUS_QUERY), false, "event_type filter + ORDER BY created_at DESC LIMIT must use an index, not SCAN");
  } finally {
    db.close();
  }
});

test("D1: schema.sql ships the audit_logs time-ordered indexes (fresh DBs stay covered)", () => {
  assert.ok(/CREATE INDEX IF NOT EXISTS idx_audit_created/.test(schemaSQL), "schema.sql must define idx_audit_created");
  assert.ok(/CREATE INDEX IF NOT EXISTS idx_audit_type_created/.test(schemaSQL), "schema.sql must define idx_audit_type_created");
});
