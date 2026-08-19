import test from "node:test";
import assert from "node:assert";
import worker from "../src/index";

// Mock Environment Builder for Worker fetch testing
function createMockEnv() {
  const clientsStore: any[] = [];
  const jobsStore: any[] = [];
  const logsStore: any[] = [];
  const metricsStore: any = { date: "2026-08-19", total_checks: 10, total_browser_seconds: 5.0, slots_found: 1, bookings_completed: 1 };

  const mockDB: any = {
    prepare: (query: string) => {
      let boundArgs: any[] = [];
      const stmt = {
        bind: (...args: any[]) => {
          boundArgs = args;
          return stmt;
        },
        first: async <T = any>() => {
          if (query.includes("jobs WHERE enabled = 1")) {
            return { count: jobsStore.filter(j => j.enabled && j.status === 'ACTIVE').length } as T;
          }
          if (query.includes("daily_metrics")) {
            return metricsStore as T;
          }
          return null;
        },
        all: async () => {
          if (query.includes("FROM clients")) {
            return { results: clientsStore };
          }
          if (query.includes("FROM audit_logs")) {
            return { results: logsStore };
          }
          return { results: [] };
        },
        run: async () => {
          if (query.includes("INSERT INTO clients")) {
            clientsStore.push({
              id: boundArgs[0],
              first_name_enc: boundArgs[1],
              last_name_enc: boundArgs[2],
              gender: boundArgs[3],
              dob: boundArgs[4],
              nationality: boundArgs[5],
              passport_number_enc: boundArgs[6],
              passport_expiry: boundArgs[7],
              email_enc: boundArgs[8],
              phone_enc: boundArgs[9],
              category: boundArgs[10],
              calendar_id: boundArgs[11],
              status: "READY",
              created_at: new Date().toISOString()
            });
          }
          if (query.includes("INSERT INTO jobs")) {
            jobsStore.push({
              id: boundArgs[0],
              client_id: boundArgs[1],
              enabled: 1,
              status: "ACTIVE",
              start_date: boundArgs[2],
              end_date: boundArgs[3],
              allowed_days: boundArgs[4]
            });
          }
          if (query.includes("UPDATE jobs SET enabled = 1")) {
            const job = jobsStore.find(j => j.id === boundArgs[0]);
            if (job) { job.enabled = 1; job.status = "ACTIVE"; }
          }
          if (query.includes("UPDATE jobs SET enabled = 0, status = 'READY'")) {
            const job = jobsStore.find(j => j.id === boundArgs[0]);
            if (job) { job.enabled = 0; job.status = "READY"; }
          }
          return { success: true };
        }
      };
      return stmt;
    }
  };

  return {
    DB: mockDB,
    JOB_LOCK: {} as any,
    SESSION_KV: {} as any,
    MYBROWSER: {} as any,
    DRY_RUN: "true",
    PII_ENCRYPTION_KEY: "test-encryption-key-32-chars-ok"
  };
}

test("API Endpoint: GET /api/status returns operational system metrics", async () => {
  const env = createMockEnv();
  const req = new Request("https://opran-booking.local/api/status");
  const res = await worker.fetch(req, env, {} as any);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get("Content-Type"), "application/json");

  const body = await res.json() as any;
  assert.strictEqual(body.status, "operational");
  assert.strictEqual(body.fastPathEnabled, true);
  assert.strictEqual(body.dryRun, true);
  assert.ok(body.cairoTime !== undefined);
});

test("API Endpoint: POST /api/clients creates encrypted client & candidate job", async () => {
  const env = createMockEnv();
  const payload = {
    firstName: "Mariam",
    lastName: "Farouk",
    category: "Master_PhD",
    passportNumber: "A98765432",
    passportExpiry: "2031-12-31",
    dob: "1997-03-21",
    gender: "Female",
    email: "mariam@example.com",
    phone: "+201111111111"
  };

  const req = new Request("https://opran-booking.local/api/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const res = await worker.fetch(req, env, {} as any);
  assert.strictEqual(res.status, 201);

  const body = await res.json() as any;
  assert.strictEqual(body.success, true);
  assert.ok(body.clientId.startsWith("client_"));
  assert.ok(body.jobId.startsWith("job_"));
});

test("API Endpoint: GET / serves interactive Admin Dashboard HTML", async () => {
  const env = createMockEnv();
  const req = new Request("https://opran-booking.local/");
  const res = await worker.fetch(req, env, {} as any);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get("Content-Type"), "text/html; charset=utf-8");

  const html = await res.text();
  assert.ok(html.includes("OPRAN BOOKING"));
  assert.ok(html.includes("FAST-PATH HTTP ~10ms"));
  assert.ok(html.includes("DRY-RUN SAFETY ACTIVE"));
});
