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
              family_name_at_birth_enc: boundArgs[10],
              place_of_birth: boundArgs[11],
              country_of_birth: boundArgs[12],
              nationality_at_birth: boundArgs[13],
              address_street_enc: boundArgs[14],
              address_postal_code_enc: boundArgs[15],
              address_city_enc: boundArgs[16],
              passport_issue_date: boundArgs[17],
              passport_issuing_country: boundArgs[18],
              category: boundArgs[19],
              calendar_id: boundArgs[20],
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
          if (query.includes("UPDATE jobs SET enabled = 0, status = 'CANCELLED'")) {
            const job = jobsStore.find(j => j.id === boundArgs[0]);
            if (job) { job.enabled = 0; job.status = "CANCELLED"; }
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
    PII_ENCRYPTION_KEY: "test-encryption-key-32-chars-ok",
    __stores: { clients: clientsStore, jobs: jobsStore }
  };
}

const FULL_PAYLOAD = {
  firstName: "Mariam",
  lastName: "Farouk",
  familyNameAtBirth: "Farouk",
  placeOfBirth: "Cairo",
  countryOfBirth: "Egypt",
  nationalityAtBirth: "Egyptian",
  street: "15 Tahrir Square",
  postalCode: "11511",
  city: "Cairo",
  passportIssueDate: "2018-06-15",
  passportIssuingCountry: "Egypt",
  category: "Master_PhD",
  passportNumber: "A98765432",
  passportExpiry: "2031-12-31",
  dob: "1997-03-21",
  gender: "Female",
  email: "mariam@example.com",
  phone: "+201111111111"
};

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

  const req = new Request("https://opran-booking.local/api/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(FULL_PAYLOAD)
  });

  const res = await worker.fetch(req, env, {} as any);
  assert.strictEqual(res.status, 201);

  const body = await res.json() as any;
  assert.strictEqual(body.success, true);
  assert.ok(body.clientId.startsWith("client_"));
  assert.ok(body.jobId.startsWith("job_"));

  const stored = env.__stores.clients[0];
  assert.ok(stored, "Mock store must hold the inserted row");
  assert.strictEqual(stored.category, "Master_PhD", "Category must land in its column position");
  assert.strictEqual(stored.calendar_id, 44279679, "calendar_id must land in its column position");
  assert.strictEqual(stored.place_of_birth, "Cairo", "Plaintext-class field must land in its column position");
  assert.notStrictEqual(stored.family_name_at_birth_enc, "Farouk", "Encrypted-class field must be ciphertext");
  assert.strictEqual(stored.passport_issuing_country, "Egypt", "Passport issuing country must land in its column position");
});

test("API Endpoint: POST /api/clients rejects missing new required field with 400", async () => {
  const env = createMockEnv();
  const payload = { ...FULL_PAYLOAD };
  delete (payload as any).passportIssuingCountry;

  const req = new Request("https://opran-booking.local/api/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const res = await worker.fetch(req, env, {} as any);
  assert.strictEqual(res.status, 400);
  const body = await res.json() as any;
  assert.ok(body.error.includes("passportIssuingCountry"), `Expected field name in error, got: ${body.error}`);
  assert.strictEqual(env.__stores.clients.length, 0, "Nothing must be written on 400");
});

test("API Endpoint: POST /api/clients rejects null body with 400", async () => {
  const env = createMockEnv();
  const req = new Request("https://opran-booking.local/api/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "null"
  });
  const res = await worker.fetch(req, env, {} as any);
  assert.strictEqual(res.status, 400);
});

test("API Endpoint: POST /api/clients rejects non-string field values with 400", async () => {
  const env = createMockEnv();
  const payload = { ...FULL_PAYLOAD, street: 12345 };
  const req = new Request("https://opran-booking.local/api/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const res = await worker.fetch(req, env, {} as any);
  assert.strictEqual(res.status, 400);
});

test("API Endpoint: POST /api/clients rejects missing original required field with 400", async () => {
  const env = createMockEnv();
  const payload = { ...FULL_PAYLOAD };
  delete (payload as any).firstName;
  const req = new Request("https://opran-booking.local/api/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const res = await worker.fetch(req, env, {} as any);
  assert.strictEqual(res.status, 400);
});

test("API Endpoint: POST /api/jobs/:id/cancel marks job cancelled and excluded from scanning", async () => {
  const env = createMockEnv();
  const createReq = new Request("https://opran-booking.local/api/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(FULL_PAYLOAD)
  });
  const created = await (await worker.fetch(createReq, env, {} as any)).json() as any;

  const cancelRes = await worker.fetch(
    new Request(`https://opran-booking.local/api/jobs/${created.jobId}/cancel`, { method: "POST" }),
    env,
    {} as any
  );
  assert.strictEqual(cancelRes.status, 200);
  const cancelBody = await cancelRes.json() as any;
  assert.strictEqual(cancelBody.action, "cancel");

  const job = env.__stores.jobs.find((j: any) => j.id === created.jobId);
  assert.ok(job, "Job must exist in store");
  assert.strictEqual(job.enabled, 0, "Cancelled job must be disabled");
  assert.strictEqual(job.status, "CANCELLED", "Cancelled job must carry terminal status");
});

test("API Endpoint: GET / serves interactive Admin Dashboard HTML", async () => {
  const env = createMockEnv();
  const req = new Request("https://opran-booking.local/");
  const res = await worker.fetch(req, env, {} as any);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get("Content-Type"), "text/html; charset=utf-8");

  const html = await res.text();
  assert.ok(html.includes("أوبيران لأتمتة الحجوزات"));
  assert.ok(html.includes("محرك الفحص السريع"));
  assert.ok(html.includes("DRY-RUN"));
  assert.ok(!html.includes("<10ms"), "Dashboard must not advertise unverified latency claims");
});

test("API Endpoint: admin form has new profile fields and no per-client schedule controls", async () => {
  const env = createMockEnv();
  const req = new Request("https://opran-booking.local/");
  const res = await worker.fetch(req, env, {} as any);
  const html = await res.text();

  const newFieldIds = ["familyNameAtBirth", "placeOfBirth", "countryOfBirth", "nationalityAtBirth",
    "street", "postalCode", "city", "passportIssueDate", "passportIssuingCountry"];
  for (const id of newFieldIds) {
    assert.ok(html.includes(`id="${id}"`), `Form must include field ${id}`);
  }

  assert.ok(html.includes("07:00") && html.includes("18:00"), "Form must show the global window");
  assert.ok(html.includes("cancel"), "Form/table must expose the cancel action");

  assert.ok(!html.includes("id=\"startDate\""), "Per-client start date control must be removed");
  assert.ok(!html.includes("id=\"endDate\""), "Per-client end date control must be removed");
  assert.ok(!html.includes("id=\"timeStart\""), "Per-client time controls must be removed");
  assert.ok(!html.includes("class=\"day-check\""), "Per-client day checkboxes must be removed");
});
