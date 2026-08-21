import test from "node:test";
import assert from "node:assert";
import worker from "../src/index";

const originalFetch = worker.fetch;
worker.fetch = async (req: Request, env: any, ctx: any) => {
  const newReq = new Request(req);
  if (!newReq.headers.has("Authorization") && newReq.headers.get("X-Skip-Auth") !== "true") {
    newReq.headers.set("Authorization", "Bearer test-admin-key");
  }
  return originalFetch(newReq, env, ctx);
};

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
          if (query.includes("FROM clients WHERE id = ?")) {
            return (clientsStore.find((c: any) => c.id === boundArgs[0]) || null) as T;
          }
          if (query.includes("FROM jobs WHERE client_id = ?")) {
            return (jobsStore.find((j: any) => j.client_id === boundArgs[0]) || null) as T;
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
          if (query.includes("UPDATE clients SET")) {
            const idx = clientsStore.findIndex((c: any) => c.id === boundArgs[20]);
            if (idx >= 0) {
              clientsStore[idx] = {
                ...clientsStore[idx],
                first_name_enc: boundArgs[0], last_name_enc: boundArgs[1], gender: boundArgs[2],
                dob: boundArgs[3], nationality: boundArgs[4], passport_number_enc: boundArgs[5],
                passport_expiry: boundArgs[6], email_enc: boundArgs[7], phone_enc: boundArgs[8],
                family_name_at_birth_enc: boundArgs[9], place_of_birth: boundArgs[10],
                country_of_birth: boundArgs[11], nationality_at_birth: boundArgs[12],
                address_street_enc: boundArgs[13], address_postal_code_enc: boundArgs[14],
                address_city_enc: boundArgs[15], passport_issue_date: boundArgs[16],
                passport_issuing_country: boundArgs[17], category: boundArgs[18], calendar_id: boundArgs[19]
              };
            }
          }
          if (query.includes("INSERT INTO audit_logs")) {
            logsStore.push({ event_type: "CLIENT_DELETED", details: boundArgs[0] });
          }
          if (query.includes("DELETE FROM clients")) {
            const idx = clientsStore.findIndex((c: any) => c.id === boundArgs[0]);
            if (idx >= 0) clientsStore.splice(idx, 1);
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
    ENVIRONMENT: "test",
    ADMIN_API_KEY: "test-admin-key",
    PII_ENCRYPTION_KEY: "test-encryption-key-32-chars-ok",
    __stores: { clients: clientsStore, jobs: jobsStore, logs: logsStore }
  };
}

const FULL_PAYLOAD = {
  firstName: "Mariam",
  lastName: "Farouk",
  familyNameAtBirth: "Farouk",
  placeOfBirth: "Cairo",
  countryOfBirth: "Egypt",
  nationalityAtBirth: "Egyptian",
  nationality: "Egyptian",
  street: "15 Tahrir Square",
  postalCode: "11511",
  city: "Cairo",
  passportIssueDate: "2018-06-15",
  passportIssuingCountry: "Egypt",
  category: "Bachelor",
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
  assert.strictEqual(body.dryRun, undefined);
  assert.ok(body.cairoTime !== undefined);
});

test("API Endpoint: GET /api/clients returns edit-prefill fields (email, phone, passportExpiry)", async () => {
  const env = createMockEnv();
  await worker.fetch(new Request("https://opran-booking.local/api/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(FULL_PAYLOAD)
  }), env, {} as any);

  const res = await worker.fetch(new Request("https://opran-booking.local/api/clients"), env, {} as any);
  assert.strictEqual(res.status, 200);
  const clients = await res.json() as any[];
  assert.strictEqual(clients[0].email, "mariam@example.com", "Email must be decrypted for prefill");
  assert.strictEqual(clients[0].phone, "+201111111111", "Phone must be decrypted for prefill");
  assert.strictEqual(clients[0].passportExpiry, "2031-12-31", "Passport expiry must be returned for prefill");
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
  assert.strictEqual(stored.category, "Bachelor", "Category must land in its column position");
  assert.strictEqual(stored.calendar_id, 44281520, "calendar_id must land in its column position");
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
  assert.ok(!html.includes("محرك الفحص السريع"), "Fastpath badge must be removed");
  assert.ok(!html.includes("badge-dryrun"), "DRY-RUN badge removed");
  assert.ok(!html.includes("sysline"), "Footer system line must be removed");
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

test("Dashboard: premium assets are present", async () => {
  const env = createMockEnv();
  const res = await worker.fetch(new Request("https://opran-booking.local/"), env, {} as any);
  const html = await res.text();

  assert.ok(!html.includes("bootstrap.rtl.min.css"), "Third-party framework CSS must be dropped for custom design system");
  assert.ok(html.includes("Alexandria"), "Premium Arabic font must be loaded");
  assert.ok(!html.includes("JetBrains+Mono"), "JetBrains Mono font request must be dropped for system mono stack");
  assert.ok(html.includes("data-theme=\"paper\""), "Paper (light) theme must be set");
  assert.ok(html.includes("--primary: #b33a2b"), "Burnt-red primary token must exist");
  assert.ok(!html.includes("--primary: #faff69"), "Legacy ClickHouse yellow token must be gone");
  assert.ok(!html.includes("--primary: #c2ef4e"), "Legacy Sentry-lime token must be gone");
  assert.ok(!html.includes("data-theme=\"night\""), "Legacy night theme must be gone");
  assert.ok(html.includes("skeleton"), "Skeleton loading state must exist");
  assert.ok(html.includes("empty-state"), "Composed empty state must exist");
  assert.ok(html.includes("dir=\"rtl\""), "Root must stay RTL for Arabic");
  // Regression: an unclosed /* comment silently swallows whole CSS rules.
  // Strip comment blocks first so rule text INSIDE a comment can't pass.
  const styleOpen = html.indexOf("<style>");
  const styleClose = html.indexOf("</style>");
  const css = html.slice(styleOpen, styleClose).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(css.includes(".grid-metrics {"), "Metric grid rule must not be swallowed by a comment");
  assert.ok(css.includes(".metric-card {"), "Metric card rule must not be swallowed by a comment");
  assert.ok(css.includes(".metric-card.featured"), "Featured card rule must not be swallowed by a comment");
});

test("Dashboard: CRUD affordances wired", async () => {
  const env = createMockEnv();
  const res = await worker.fetch(new Request("https://opran-booking.local/"), env, {} as any);
  const html = await res.text();

  assert.ok(html.includes("openEditModal"), "Edit mode must be wired to the shared modal");
  assert.ok(html.includes("deleteClient"), "Delete action must be wired");
  assert.ok(html.includes("confirm("), "Delete must require native confirmation");
  assert.ok(html.includes("client-form-error"), "Inline form error box must exist");
  assert.ok(html.includes("empty-state"), "Composed empty state must exist");
  assert.ok(!html.includes("فشل الحفظ"), "Legacy alert-based form error must be removed");
  assert.ok(html.includes("passportNumber').required = true"), "Add mode must require the passport");
  assert.ok(html.includes("passportNumber').required = false"), "Edit mode must allow empty passport (keep existing)");
});

test("API Endpoint: PUT /api/clients/:id rejects missing field with 400", async () => {
  const env = createMockEnv();
  const createReq = new Request("https://opran-booking.local/api/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(FULL_PAYLOAD)
  });
  const created = await (await worker.fetch(createReq, env, {} as any)).json() as any;

  const payload = { ...FULL_PAYLOAD };
  delete (payload as any).city;
  const res = await worker.fetch(
    new Request(`https://opran-booking.local/api/clients/${created.clientId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
    env,
    {} as any
  );
  assert.strictEqual(res.status, 400);
  const body = await res.json() as any;
  assert.ok(body.error.includes("city"), `Expected field name in error, got: ${body.error}`);
});

test("API Endpoint: PUT /api/clients/:id rejects non-string field with 400", async () => {
  const env = createMockEnv();
  const res = await worker.fetch(
    new Request("https://opran-booking.local/api/clients/client_x", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...FULL_PAYLOAD, street: 12345 })
    }),
    env,
    {} as any
  );
  assert.strictEqual(res.status, 400);
});

test("API Endpoint: PUT /api/clients/:id rejects unknown id with 404", async () => {
  const env = createMockEnv();
  const res = await worker.fetch(
    new Request("https://opran-booking.local/api/clients/client_unknown", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(FULL_PAYLOAD)
    }),
    env,
    {} as any
  );
  assert.strictEqual(res.status, 404);
  const body = await res.json() as any;
  assert.match(body.error, /not found/i);
});

test("API Endpoint: PUT /api/clients/:id updates stored row and keeps empty passport ciphertext", async () => {
  const env = createMockEnv();
  const created = await (await worker.fetch(new Request("https://opran-booking.local/api/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(FULL_PAYLOAD)
  }), env, {} as any)).json() as any;

  const beforePassport = env.__stores.clients[0].passport_number_enc;
  assert.ok(beforePassport, "Store must hold ciphertext after POST");

  const res = await worker.fetch(
    new Request(`https://opran-booking.local/api/clients/${created.clientId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...FULL_PAYLOAD, firstName: "Salma", category: "Bachelor", passportNumber: "" })
    }),
    env,
    {} as any
  );
  assert.strictEqual(res.status, 200);

  const stored = env.__stores.clients[0];
  assert.notStrictEqual(stored.first_name_enc, "Mariam", "First name must be re-encrypted");
  assert.strictEqual(stored.category, "Bachelor", "Category must update");
  assert.strictEqual(stored.calendar_id, 44281520, "calendar_id must follow the new category");
  assert.strictEqual(stored.passport_number_enc, beforePassport, "Empty passport must keep existing ciphertext");
});

test("API Endpoint: DELETE /api/clients/:id rejects unknown id with 404", async () => {
  const env = createMockEnv();
  const res = await worker.fetch(
    new Request("https://opran-booking.local/api/clients/client_unknown", { method: "DELETE" }),
    env,
    {} as any
  );
  assert.strictEqual(res.status, 404);
});

test("API Endpoint: DELETE /api/clients/:id protects BOOKED clients with 403", async () => {
  const env = createMockEnv();
  const created = await (await worker.fetch(new Request("https://opran-booking.local/api/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(FULL_PAYLOAD)
  }), env, {} as any)).json() as any;

  env.__stores.jobs.find((j: any) => j.client_id === created.clientId).status = "BOOKED";

  const res = await worker.fetch(
    new Request(`https://opran-booking.local/api/clients/${created.clientId}`, { method: "DELETE" }),
    env,
    {} as any
  );
  assert.strictEqual(res.status, 403);
  const body = await res.json() as any;
  assert.match(body.error, /BOOKED/);
  assert.strictEqual(env.__stores.clients.length, 1, "BOOKED client must not be deleted");
});

test("API Endpoint: DELETE /api/clients/:id removes client and writes audit row", async () => {
  const env = createMockEnv();
  const created = await (await worker.fetch(new Request("https://opran-booking.local/api/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(FULL_PAYLOAD)
  }), env, {} as any)).json() as any;

  const res = await worker.fetch(
    new Request(`https://opran-booking.local/api/clients/${created.clientId}`, { method: "DELETE" }),
    env,
    {} as any
  );
  assert.strictEqual(res.status, 200);
  assert.strictEqual(env.__stores.clients.length, 0, "Client must be removed from store");
  const audit = env.__stores.logs?.[0];
  assert.ok(audit, "Audit row must be written");
  assert.strictEqual(audit.event_type, "CLIENT_DELETED");
  assert.strictEqual(audit.details, created.clientId);
});

// ============================================================================
// EXHAUSTIVE CRUD VALIDATION & EDGE CASE TEST SUITES (Candidate Client Model)
// ============================================================================

const ALL_REQUIRED_FIELDS = [
  "firstName", "lastName", "passportNumber", "passportExpiry", "dob",
  "email", "phone", "category", "familyNameAtBirth", "placeOfBirth", "countryOfBirth",
  "nationalityAtBirth", "street", "postalCode", "city", "passportIssueDate", "passportIssuingCountry"
] as const;

// 1. POST /api/clients - Comprehensive Payload & Required Fields Validation
test("API Endpoint: POST /api/clients rejects non-object & malformed JSON bodies", async () => {
  const env = createMockEnv();

  // Test malformed JSON string
  const resMalformed = await worker.fetch(
    new Request("https://opran-booking.local/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ invalid json structure"
    }),
    env, {} as any
  );
  assert.strictEqual(resMalformed.status, 400);
  assert.strictEqual((await resMalformed.json() as any).error, "Invalid JSON body");

  // Test JSON Array body
  const resArray = await worker.fetch(
    new Request("https://opran-booking.local/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([FULL_PAYLOAD])
    }),
    env, {} as any
  );
  assert.strictEqual(resArray.status, 400);
  assert.strictEqual((await resArray.json() as any).error, "Invalid JSON body");

  // Test primitive string body
  const resPrimitive = await worker.fetch(
    new Request("https://opran-booking.local/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify("plain string body")
    }),
    env, {} as any
  );
  assert.strictEqual(resPrimitive.status, 400);
  assert.strictEqual((await resPrimitive.json() as any).error, "Invalid JSON body");
});

test("API Endpoint: POST /api/clients validates each of the 17 required fields individually", async () => {
  for (const field of ALL_REQUIRED_FIELDS) {
    const env = createMockEnv();

    // a) Missing key altogether
    const payloadMissing = { ...FULL_PAYLOAD };
    delete (payloadMissing as any)[field];
    const resMissing = await worker.fetch(
      new Request("https://opran-booking.local/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadMissing)
      }),
      env, {} as any
    );
    assert.strictEqual(resMissing.status, 400, `Expected 400 when missing ${field}`);
    const errMissing = (await resMissing.json() as any).error;
    assert.strictEqual(errMissing, `Missing required field: ${field}`);

    // b) Empty string ""
    const payloadEmpty = { ...FULL_PAYLOAD, [field]: "" };
    const resEmpty = await worker.fetch(
      new Request("https://opran-booking.local/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadEmpty)
      }),
      env, {} as any
    );
    assert.strictEqual(resEmpty.status, 400, `Expected 400 when ${field} is empty string`);
    assert.strictEqual((await resEmpty.json() as any).error, `Missing required field: ${field}`);

    // c) Whitespace-only string "   "
    const payloadSpaces = { ...FULL_PAYLOAD, [field]: "   " };
    const resSpaces = await worker.fetch(
      new Request("https://opran-booking.local/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadSpaces)
      }),
      env, {} as any
    );
    assert.strictEqual(resSpaces.status, 400, `Expected 400 when ${field} is whitespace only`);
    assert.strictEqual((await resSpaces.json() as any).error, `Missing required field: ${field}`);

    // d) Non-string type (number 12345)
    const payloadNumber = { ...FULL_PAYLOAD, [field]: 12345 };
    const resNumber = await worker.fetch(
      new Request("https://opran-booking.local/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadNumber)
      }),
      env, {} as any
    );
    assert.strictEqual(resNumber.status, 400, `Expected 400 when ${field} is a number`);
    assert.strictEqual((await resNumber.json() as any).error, `Missing required field: ${field}`);
  }
});

test("API Endpoint: POST /api/clients applies defaults and maps calendarId correctly", async () => {
  // Test Category = "Bachelor" with omitted gender -> defaults to Male, calendarId = 44281520
  const env1 = createMockEnv();
  const payloadBachelor = { ...FULL_PAYLOAD, category: "Bachelor" };
  delete (payloadBachelor as any).gender;

  const res1 = await worker.fetch(
    new Request("https://opran-booking.local/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloadBachelor)
    }),
    env1, {} as any
  );
  assert.strictEqual(res1.status, 201);
  const stored1 = env1.__stores.clients[0];
  assert.strictEqual(stored1.category, "Bachelor");
  assert.strictEqual(stored1.calendar_id, 44281520);
  assert.strictEqual(stored1.gender, "Male", "Omitted gender must default to Male");
  assert.strictEqual(stored1.nationality, "Egyptian", "Explicit nationality must be stored as-is");

  // Test Category = "Bachelor" with explicit Female gender and Austrian nationality
  const env2 = createMockEnv();
  const payloadExplicit = { ...FULL_PAYLOAD, category: "Bachelor", gender: "Female", nationality: "Austrian" };
  const res2 = await worker.fetch(
    new Request("https://opran-booking.local/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloadExplicit)
    }),
    env2, {} as any
  );
  assert.strictEqual(res2.status, 201);
  const stored2 = env2.__stores.clients[0];
  assert.strictEqual(stored2.category, "Bachelor");
  assert.strictEqual(stored2.calendar_id, 44281520);
  assert.strictEqual(stored2.gender, "Female");
  assert.strictEqual(stored2.nationality, "Austrian");
});

test("API Endpoint: POST /api/clients auto-creates job with correct default scheduling parameters", async () => {
  const env = createMockEnv();
  const res = await worker.fetch(
    new Request("https://opran-booking.local/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(FULL_PAYLOAD)
    }),
    env, {} as any
  );
  assert.strictEqual(res.status, 201);
  const body = await res.json() as any;

  const job = env.__stores.jobs.find((j: any) => j.id === body.jobId);
  assert.ok(job, "Auto-created job record must exist");
  assert.strictEqual(job.client_id, body.clientId);
  assert.strictEqual(job.enabled, 1, "Job must be enabled by default");
  assert.strictEqual(job.status, "ACTIVE", "Job status must be ACTIVE by default");
  assert.strictEqual(job.start_date, new Date().toISOString().slice(0, 10));
  const expectedEndDate = new Date(Date.now() + 8 * 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assert.strictEqual(job.end_date, expectedEndDate);
  const days = JSON.parse(job.allowed_days);
  assert.deepStrictEqual(days, ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
});

// 2. PUT /api/clients/:id - Comprehensive Validation & Passport Special Rule
test("API Endpoint: PUT /api/clients/:id rejects non-object & malformed JSON bodies", async () => {
  const env = createMockEnv();

  const resMalformed = await worker.fetch(
    new Request("https://opran-booking.local/api/clients/client_123", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not json"
    }),
    env, {} as any
  );
  assert.strictEqual(resMalformed.status, 400);
  assert.strictEqual((await resMalformed.json() as any).error, "Invalid JSON body");
});

test("API Endpoint: PUT /api/clients/:id passportNumber special rule (empty keeps existing, missing/non-string fails)", async () => {
  const env = createMockEnv();

  // Create initial client
  const created = await (await worker.fetch(
    new Request("https://opran-booking.local/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(FULL_PAYLOAD)
    }),
    env, {} as any
  )).json() as any;

  const originalPassportEnc = env.__stores.clients[0].passport_number_enc;
  assert.ok(originalPassportEnc, "Original passport ciphertext must exist");

  // a) Empty string passportNumber "" -> Allowed! Keeps existing ciphertext
  const resEmptyPassport = await worker.fetch(
    new Request(`https://opran-booking.local/api/clients/${created.clientId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...FULL_PAYLOAD, passportNumber: "" })
    }),
    env, {} as any
  );
  assert.strictEqual(resEmptyPassport.status, 200);
  assert.strictEqual(env.__stores.clients[0].passport_number_enc, originalPassportEnc);

  // b) Whitespace string passportNumber "   " -> Allowed! Keeps existing ciphertext
  const resSpacesPassport = await worker.fetch(
    new Request(`https://opran-booking.local/api/clients/${created.clientId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...FULL_PAYLOAD, passportNumber: "   " })
    }),
    env, {} as any
  );
  assert.strictEqual(resSpacesPassport.status, 200);
  assert.strictEqual(env.__stores.clients[0].passport_number_enc, originalPassportEnc);

  // c) Missing passportNumber key altogether -> Rejected with 400
  const payloadNoPassport = { ...FULL_PAYLOAD };
  delete (payloadNoPassport as any).passportNumber;
  const resMissingPassport = await worker.fetch(
    new Request(`https://opran-booking.local/api/clients/${created.clientId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloadNoPassport)
    }),
    env, {} as any
  );
  assert.strictEqual(resMissingPassport.status, 400);
  assert.strictEqual((await resMissingPassport.json() as any).error, "Missing required field: passportNumber");

  // d) Non-string passportNumber (number 99999) -> Rejected with 400
  const resNumberPassport = await worker.fetch(
    new Request(`https://opran-booking.local/api/clients/${created.clientId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...FULL_PAYLOAD, passportNumber: 99999 })
    }),
    env, {} as any
  );
  assert.strictEqual(resNumberPassport.status, 400);
  assert.strictEqual((await resNumberPassport.json() as any).error, "Missing required field: passportNumber");
});

test("API Endpoint: PUT /api/clients/:id validates the other 16 required fields individually", async () => {
  const other16Fields = ALL_REQUIRED_FIELDS.filter(f => f !== "passportNumber");

  for (const field of other16Fields) {
    const env = createMockEnv();
    const created = await (await worker.fetch(
      new Request("https://opran-booking.local/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(FULL_PAYLOAD)
      }),
      env, {} as any
    )).json() as any;

    // a) Missing field key
    const payloadMissing = { ...FULL_PAYLOAD };
    delete (payloadMissing as any)[field];
    const resMissing = await worker.fetch(
      new Request(`https://opran-booking.local/api/clients/${created.clientId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadMissing)
      }),
      env, {} as any
    );
    assert.strictEqual(resMissing.status, 400, `PUT expected 400 when missing ${field}`);
    assert.strictEqual((await resMissing.json() as any).error, `Missing required field: ${field}`);

    // b) Empty string
    const payloadEmpty = { ...FULL_PAYLOAD, [field]: "" };
    const resEmpty = await worker.fetch(
      new Request(`https://opran-booking.local/api/clients/${created.clientId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadEmpty)
      }),
      env, {} as any
    );
    assert.strictEqual(resEmpty.status, 400, `PUT expected 400 when ${field} is empty string`);

    // c) Whitespace string
    const payloadSpaces = { ...FULL_PAYLOAD, [field]: "  " };
    const resSpaces = await worker.fetch(
      new Request(`https://opran-booking.local/api/clients/${created.clientId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadSpaces)
      }),
      env, {} as any
    );
    assert.strictEqual(resSpaces.status, 400, `PUT expected 400 when ${field} is whitespace string`);

    // d) Non-string type
    const payloadNum = { ...FULL_PAYLOAD, [field]: 888 };
    const resNum = await worker.fetch(
      new Request(`https://opran-booking.local/api/clients/${created.clientId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadNum)
      }),
      env, {} as any
    );
    assert.strictEqual(resNum.status, 400, `PUT expected 400 when ${field} is number`);
  }
});

// 3. DELETE /api/clients/:id - FK Reference Handling & Cascade Assertions
test("API Endpoint: DELETE /api/clients/:id detaches audit log FK references before removing client", async () => {
  const env = createMockEnv();
  const created = await (await worker.fetch(
    new Request("https://opran-booking.local/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(FULL_PAYLOAD)
    }),
    env, {} as any
  )).json() as any;

  // Add mock pre-existing audit log for this client
  env.__stores.logs.push({
    id: 1,
    job_id: created.jobId,
    client_id: created.clientId,
    event_type: "NO_APPOINTMENT"
  });

  const res = await worker.fetch(
    new Request(`https://opran-booking.local/api/clients/${created.clientId}`, { method: "DELETE" }),
    env, {} as any
  );
  assert.strictEqual(res.status, 200);
  assert.strictEqual(env.__stores.clients.length, 0, "Client must be deleted");

  // Verify deletion audit log is created
  const deletionLog = env.__stores.logs.find((l: any) => l.event_type === "CLIENT_DELETED");
  assert.ok(deletionLog, "CLIENT_DELETED audit log must be created");
  assert.strictEqual(deletionLog.details, created.clientId);
});

// 4. GET /api/clients - Decryption, Masking & Empty String Safety
test("API Endpoint: GET /api/clients returns correctly decrypted PII fields and masked passport", async () => {
  const env = createMockEnv();
  await worker.fetch(
    new Request("https://opran-booking.local/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(FULL_PAYLOAD)
    }),
    env, {} as any
  );

  const res = await worker.fetch(new Request("https://opran-booking.local/api/clients"), env, {} as any);
  assert.strictEqual(res.status, 200);

  const list = await res.json() as any[];
  assert.strictEqual(list.length, 1);
  const client = list[0];

  assert.strictEqual(client.firstName, "Mariam");
  assert.strictEqual(client.lastName, "Farouk");
  assert.strictEqual(client.familyNameAtBirth, "Farouk");
  assert.strictEqual(client.placeOfBirth, "Cairo");
  assert.strictEqual(client.countryOfBirth, "Egypt");
  assert.strictEqual(client.nationalityAtBirth, "Egyptian");
  assert.strictEqual(client.street, "15 Tahrir Square");
  assert.strictEqual(client.postalCode, "11511");
  assert.strictEqual(client.city, "Cairo");
  assert.strictEqual(client.passportIssueDate, "2018-06-15");
  assert.strictEqual(client.passportIssuingCountry, "Egypt");
  assert.strictEqual(client.gender, "Female");
  assert.strictEqual(client.dob, "1997-03-21");
  assert.strictEqual(client.nationality, "Egyptian");
  assert.strictEqual(client.email, "mariam@example.com");
  assert.strictEqual(client.phone, "+201111111111");
  assert.strictEqual(client.passportExpiry, "2031-12-31");

  // Passport masking assertion
  assert.strictEqual(client.maskedPassport, "A9****32");
  assert.ok(!JSON.stringify(client).includes("A98765432"), "Raw passport must never be exposed in API output");
});

// 5. Static UI Verification - Match getAdminHTML DOM IDs with requiredFields & payload keys
test("Static UI Verification: getAdminHTML DOM IDs match requiredFields and add-client-form payload keys", async () => {
  const env = createMockEnv();
  const res = await worker.fetch(new Request("https://opran-booking.local/"), env, {} as any);
  const html = await res.text();

  // 1. Verify every field in ALL_REQUIRED_FIELDS exists as a DOM element with id="<field>"
  for (const field of ALL_REQUIRED_FIELDS) {
    const hasId = html.includes(`id="${field}"`);
    assert.ok(hasId, `Admin dashboard HTML must contain DOM element id="${field}"`);
  }

  // 2. Verify onsubmit payload builder extracts every required field from document.getElementById('<field>').value
  const submitHandlerMatch = html.match(/document\.getElementById\('add-client-form'\)\.onsubmit[\s\S]*?body:\s*JSON\.stringify\(payload\)/);
  assert.ok(submitHandlerMatch, "onsubmit payload handler must exist in HTML script");

  const handlerCode = submitHandlerMatch[0];
  for (const field of ALL_REQUIRED_FIELDS) {
    const extractsField = handlerCode.includes(`${field}: document.getElementById('${field}').value`);
    assert.ok(extractsField, `onsubmit handler must extract payload key ${field} from document.getElementById('${field}')`);
  }
});

// 6. Category Enum Validation & Booking Helper Utilities Test Suite
test("API Endpoint: POST & PUT /api/clients reject invalid category with 400 Bad Request", async () => {
  const env = createMockEnv();

  // POST with invalid category
  const resPost = await worker.fetch(
    new Request("https://opran-booking.local/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...FULL_PAYLOAD, category: "Tourist_Visa" })
    }),
    env, {} as any
  );
  assert.strictEqual(resPost.status, 400);
  const postErr = (await resPost.json() as any).error;
  assert.strictEqual(postErr, "Invalid category. Must be 'Bachelor'");

  // POST with Master_PhD (rejected in Bachelor-only MVP)
  const resPostMaster = await worker.fetch(
    new Request("https://opran-booking.local/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...FULL_PAYLOAD, category: "Master_PhD" })
    }),
    env, {} as any
  );
  assert.strictEqual(resPostMaster.status, 400);
  assert.strictEqual((await resPostMaster.json() as any).error, "Invalid category. Must be 'Bachelor'");

  // Create valid client
  const created = await (await worker.fetch(
    new Request("https://opran-booking.local/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(FULL_PAYLOAD)
    }),
    env, {} as any
  )).json() as any;

  // PUT with invalid category
  const resPut = await worker.fetch(
    new Request(`https://opran-booking.local/api/clients/${created.clientId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...FULL_PAYLOAD, category: "Work_Permit" })
    }),
    env, {} as any
  );
  assert.strictEqual(resPut.status, 400);
  const putErr = (await resPut.json() as any).error;
  assert.strictEqual(putErr, "Invalid category. Must be 'Bachelor'");

  // PUT with Master_PhD (rejected in Bachelor-only MVP)
  const resPutMaster = await worker.fetch(
    new Request(`https://opran-booking.local/api/clients/${created.clientId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...FULL_PAYLOAD, category: "Master_PhD" })
    }),
    env, {} as any
  );
  assert.strictEqual(resPutMaster.status, 400);
  assert.strictEqual((await resPutMaster.json() as any).error, "Invalid category. Must be 'Bachelor'");
});

test("Booking Engine Utility: formatDateForPortal converts YYYY-MM-DD to MM/DD/YYYY format", async () => {
  const { formatDateForPortal } = await import("../src/booking-http");

  assert.strictEqual(formatDateForPortal("1997-03-21"), "03/21/1997");
  assert.strictEqual(formatDateForPortal("2018-06-15"), "06/15/2018");
  assert.strictEqual(formatDateForPortal("2031-12-31"), "12/31/2031");

  // Pass-through for already formatted dates
  assert.strictEqual(formatDateForPortal("03/21/1997"), "03/21/1997");
  assert.strictEqual(formatDateForPortal(""), "");
});

test("Booking Engine Utility: buildStep3DetailsPayload includes all 18 PII fields, consent, and CAPTCHA", async () => {
  const { buildStep3DetailsPayload } = await import("../src/booking-http");

  const sampleClient = {
    id: "client_1",
    firstName: "Amr",
    lastName: "Abdin",
    familyNameAtBirth: "Abdin",
    placeOfBirth: "Cairo",
    countryOfBirth: "EGYPT",
    nationalityAtBirth: "Egyptian",
    street: "sadat sreet",
    postalCode: "01111",
    city: "Mansora",
    passportIssueDate: "2018-06-15",
    passportIssuingCountry: "Egypt",
    gender: "Male",
    dob: "1987-05-03",
    nationality: "EGYPT",
    passportNumber: "A22987645",
    passportExpiry: "2028-06-14",
    email: "sam.elkomy@yahoo.com",
    phone: "01005643765",
    category: "Bachelor",
    calendarId: 44281520
  };

  const payloadStr = buildStep3DetailsPayload(sampleClient, "4438", "06/05/2018", "10:10");
  const params = new URLSearchParams(payloadStr);

  assert.strictEqual(params.get("Office"), "KAIRO");
  assert.strictEqual(params.get("CalendarId"), "44281520");
  assert.strictEqual(params.get("Lastname"), "Abdin");
  assert.strictEqual(params.get("Firstname"), "Amr");
  assert.strictEqual(params.get("DateOfBirth"), "05/03/1987");
  assert.strictEqual(params.get("TraveldocumentNumber"), "A22987645");
  assert.strictEqual(params.get("Sex"), "Male");
  assert.strictEqual(params.get("Street"), "sadat sreet");
  assert.strictEqual(params.get("Postcode"), "01111");
  assert.strictEqual(params.get("City"), "Mansora");
  assert.strictEqual(params.get("Country"), "EGYPT");
  assert.strictEqual(params.get("Telephone"), "01005643765");
  assert.strictEqual(params.get("Email"), "sam.elkomy@yahoo.com");
  assert.strictEqual(params.get("TraveldocumentDateOfIssue"), "06/15/2018");
  assert.strictEqual(params.get("DSGVOAccepted"), "true");
  assert.strictEqual(params.get("CaptchaText"), "4438");
  assert.strictEqual(params.get("Command"), "Save");
});

test("Booking Engine Utility: parseBookingConfirmationReference extracts reference numbers from confirmation HTML", async () => {
  const { parseBookingConfirmationReference } = await import("../src/booking-http");

  const sampleHtml = `
    <html>
      <body>
        <h1>Terminreservierung - تأكيد الحجز</h1>
        <p>لقد تم عمل الحجز</p>
        <div>رقم الحجز: GESX-KAIRO</div>
      </body>
    </html>
  `;

  assert.strictEqual(parseBookingConfirmationReference(sampleHtml), "GESX-KAIRO");

  const sampleHtml2 = `<div>Reference ID: GESX-998877</div>`;
  assert.strictEqual(parseBookingConfirmationReference(sampleHtml2), "GESX-998877");

  assert.strictEqual(parseBookingConfirmationReference("<html>no reference</html>"), null);
});

test("API Security: Unauthenticated request to protected endpoint returns 401 Unauthorized", async () => {
  const env = createMockEnv();
  const req = new Request("https://opran-booking.local/api/status", {
    headers: { "X-Skip-Auth": "true" } // Prevents the monkey-patch from injecting the token
  });
  const res = await worker.fetch(req, env, {} as any);
  assert.strictEqual(res.status, 401);
});

test("API Security: Missing ADMIN_API_KEY in production returns 500", async () => {
  const env = createMockEnv();
  env.ENVIRONMENT = "production";
  delete env.ADMIN_API_KEY;
  const req = new Request("https://opran-booking.local/api/status", {
    headers: { "X-Skip-Auth": "true" }
  });
  const res = await worker.fetch(req, env, {} as any);
  assert.strictEqual(res.status, 500);
});

test("API Security: Authenticated request via Bearer token", async () => {
  const env = createMockEnv();
  const req = new Request("https://opran-booking.local/api/status", {
    headers: { "Authorization": "Bearer test-admin-key", "X-Skip-Auth": "true" }
  });
  const res = await worker.fetch(req, env, {} as any);
  assert.strictEqual(res.status, 200);
});

test("API Security: Authenticated request via X-API-Key header", async () => {
  const env = createMockEnv();
  const req = new Request("https://opran-booking.local/api/status", {
    headers: { "X-API-Key": "test-admin-key", "X-Skip-Auth": "true" }
  });
  const res = await worker.fetch(req, env, {} as any);
  assert.strictEqual(res.status, 200);
});

test("API Security: Authenticated request via Basic Auth", async () => {
  const env = createMockEnv();
  const basicAuth = btoa("admin:test-admin-key");
  const req = new Request("https://opran-booking.local/api/status", {
    headers: { "Authorization": `Basic ${basicAuth}`, "X-Skip-Auth": "true" }
  });
  const res = await worker.fetch(req, env, {} as any);
  assert.strictEqual(res.status, 200);
});

test("API Validation: POST /api/clients rejects missing nationality field with 400", async () => {
  const env = createMockEnv();
  const { nationality, ...withoutNationality } = FULL_PAYLOAD;
  const res = await worker.fetch(
    new Request("https://opran-booking.local/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(withoutNationality)
    }), env, {} as any);
  assert.strictEqual(res.status, 400);
  const body = await res.json() as any;
  assert.ok(body.error.includes("nationality"), `Error should mention nationality: ${body.error}`);
});

test("Pre-Submit Gate: blocks on missing required field", async () => {
  const { checkPreSubmitGate } = await import("../src/pre-submit-gate");
  const incomplete: any = {
    id: "test", firstName: "Ahmed", lastName: "", familyNameAtBirth: "Hassan",
    placeOfBirth: "Cairo", countryOfBirth: "Egypt", nationalityAtBirth: "Egyptian",
    street: "15 Tahrir", postalCode: "11511", city: "Cairo",
    passportIssueDate: "2018-06-15", passportIssuingCountry: "Egypt",
    gender: "Male", dob: "1997-03-21", nationality: "Egyptian",
    passportNumber: "A12345678", passportExpiry: "2030-01-01",
    email: "test@test.com", phone: "+201000000000",
    category: "Bachelor", calendarId: 44281520
  };
  const result = checkPreSubmitGate(incomplete);
  assert.strictEqual(result.ready, false);
  assert.ok(result.blockers.some(b => b.includes("lastName")));
});

test("Pre-Submit Gate: passes on complete valid data", async () => {
  const { checkPreSubmitGate } = await import("../src/pre-submit-gate");
  const complete: any = {
    id: "test", firstName: "Ahmed", lastName: "Hassan", familyNameAtBirth: "Hassan",
    placeOfBirth: "Cairo", countryOfBirth: "Egypt", nationalityAtBirth: "Egyptian",
    street: "15 Tahrir", postalCode: "11511", city: "Cairo",
    passportIssueDate: "2018-06-15", passportIssuingCountry: "Egypt",
    gender: "Male", dob: "1997-03-21", nationality: "Egyptian",
    passportNumber: "A12345678", passportExpiry: "2030-01-01",
    email: "test@test.com", phone: "+201000000000",
    category: "Bachelor", calendarId: 44281520
  };
  const result = checkPreSubmitGate(complete);
  assert.strictEqual(result.ready, true);
  assert.strictEqual(result.blockers.length, 0);
});

test("Pre-Submit Gate: blocks on unknown calendarId", async () => {
  const { checkPreSubmitGate } = await import("../src/pre-submit-gate");
  const badCalendar: any = {
    id: "test", firstName: "Ahmed", lastName: "Hassan", familyNameAtBirth: "Hassan",
    placeOfBirth: "Cairo", countryOfBirth: "Egypt", nationalityAtBirth: "Egyptian",
    street: "15 Tahrir", postalCode: "11511", city: "Cairo",
    passportIssueDate: "2018-06-15", passportIssuingCountry: "Egypt",
    gender: "Male", dob: "1997-03-21", nationality: "Egyptian",
    passportNumber: "A12345678", passportExpiry: "2030-01-01",
    email: "test@test.com", phone: "+201000000000",
    category: "Bachelor", calendarId: 99999
  };
  const result = checkPreSubmitGate(badCalendar);
  assert.strictEqual(result.ready, false);
  assert.ok(result.blockers.some(b => b.includes("calendarId")));
});

test("Pre-Submit Gate: blocks on invalid date format", async () => {
  const { checkPreSubmitGate } = await import("../src/pre-submit-gate");
  const badDate: any = {
    id: "test", firstName: "Ahmed", lastName: "Hassan", familyNameAtBirth: "Hassan",
    placeOfBirth: "Cairo", countryOfBirth: "Egypt", nationalityAtBirth: "Egyptian",
    street: "15 Tahrir", postalCode: "11511", city: "Cairo",
    passportIssueDate: "15/06/2018", passportIssuingCountry: "Egypt",
    gender: "Male", dob: "1997-03-21", nationality: "Egyptian",
    passportNumber: "A12345678", passportExpiry: "2030-01-01",
    email: "test@test.com", phone: "+201000000000",
    category: "Bachelor", calendarId: 44281520
  };
  const result = checkPreSubmitGate(badDate);
  assert.strictEqual(result.ready, false);
  assert.ok(result.blockers.some(b => b.includes("passportIssueDate")));
});

test("Portal Field Names: buildStep3DetailsPayload uses exact verified portal names (regression)", async () => {
  const { buildStep3DetailsPayload } = await import("../src/booking-http");
  const client: any = {
    id: "test", firstName: "Ahmed", lastName: "Hassan", familyNameAtBirth: "Hassan",
    placeOfBirth: "Cairo", countryOfBirth: "Egypt", nationalityAtBirth: "Egyptian",
    street: "15 Tahrir", postalCode: "11511", city: "Cairo",
    passportIssueDate: "2018-06-15", passportIssuingCountry: "Egypt",
    gender: "Male", dob: "1997-03-21", nationality: "Egyptian",
    passportNumber: "A12345678", passportExpiry: "2030-01-01",
    email: "test@test.com", phone: "+201000000000",
    category: "Bachelor", calendarId: 44281520
  };
  const payload = buildStep3DetailsPayload(client, "TEST");
  const params = new URLSearchParams(payload);
  
  // Verified portal field names — must be exact case-sensitive match
  const verifiedNames = [
    "Lastname", "Firstname", "DateOfBirth", "TraveldocumentNumber", "Sex",
    "Street", "Postcode", "City", "Country", "Telephone", "Email",
    "LastnameAtBirth", "NationalityAtBirth", "CountryOfBirth", "PlaceOfBirth",
    "NationalityForApplication", "TraveldocumentDateOfIssue",
    "TraveldocumentValidUntil", "TraveldocumentIssuingAuthority",
    "DSGVOAccepted", "CaptchaText", "Command"
  ];
  for (const name of verifiedNames) {
    assert.ok(params.has(name), `Portal field "${name}" must be present in payload`);
  }
  
  // Regression: these FABRICATED names must NOT appear
  const fabricated = ["LastName", "FirstName", "DOB", "PassportNumber", "Gender", "PostalCode", "Phone"];
  for (const name of fabricated) {
    assert.ok(!params.has(name), `Fabricated field "${name}" must NOT appear in payload`);
  }
});

test("Panel Field Completeness: admin HTML contains all 19 static client input fields", async () => {
  const env = createMockEnv();
  const res = await worker.fetch(new Request("https://opran-booking.local/"), env, {} as any);
  const html = await res.text();
  const requiredInputIds = [
    "firstName", "lastName", "familyNameAtBirth", "placeOfBirth", "countryOfBirth",
    "nationalityAtBirth", "nationality", "street", "postalCode", "city",
    "passportNumber", "passportExpiry", "passportIssueDate", "passportIssuingCountry",
    "dob", "gender", "email", "phone", "category"
  ];
  for (const id of requiredInputIds) {
    assert.ok(html.includes(`id="${id}"`), `Admin form must contain input with id="${id}"`);
  }
});
