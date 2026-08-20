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
    DRY_RUN: "true",
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
  assert.ok(!html.includes("محرك الفحص السريع"), "Fastpath badge must be removed");
  assert.ok(!html.includes("badge-dryrun"), "DRY-RUN badge must be removed");
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
