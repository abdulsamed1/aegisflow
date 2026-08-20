# SPA Client CRUD + Premium UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full client CRUD (update + delete) in the Worker-served dashboard, restyled to a premium 2027 look using Bootstrap 5.3 RTL CSS (CDN, CSS-only) with zero build step and no change to the booking hot path.

**Architecture:** Single Cloudflare Worker (`src/index.ts`) serves both API and the dashboard HTML. PUT/DELETE routes join the existing route chain in `fetch()`. The dashboard keeps its inline vanilla JS; Bootstrap CSS (RTL, SRI-pinned, no JS bundle) supplies form/table/modal/button components; delete confirmation uses native `confirm()`.

**Tech Stack:** TypeScript, Cloudflare Workers + D1, node:test + Miniflare, Bootstrap 5.3.8 RTL CSS via jsDelivr, Google Fonts (Alexandria + JetBrains Mono).

## Global Constraints

- Source of truth: `docs/implementation-artifacts/spec-spa-crud-premium-ui.md` (baseline commit `e37f695`, status `ready-for-review`).
- Booking hot path untouched: no changes to `src/scheduler.ts`, `src/scanner.ts`, `src/booking-http.ts`, `scheduled()` logic.
- No new npm dependencies. No bundler, no framework. Bootstrap + fonts load from CDN only.
- Test commands: `npm test` (all suites), targeted: `node --import tsx --test --test-name-pattern="<pattern>" test/<file>.test.ts`.
- Encrypted fields (never plaintext in API/DB): firstName, lastName, familyNameAtBirth, street, postalCode, city, passportNumber, email, phone. Plaintext fields: placeOfBirth, countryOfBirth, nationalityAtBirth, passportIssueDate, passportIssuingCountry, dob, gender, nationality, passportExpiry, category, calendarId.
- calendar_id mapping: `body.category === "Master_PhD" ? 44279679 : 44281520`.
- Arabic UI copy, RTL. No `window.alert()` for form errors (inline Bootstrap alert instead). Native `confirm()` for delete.
- No schema change: audit rows on delete use `details` (not `client_id` FK) — deleting the referenced row would violate the FK.
- Production deploy is operator-gated: deploy only in Task 6, after all tests and typecheck pass.

---

### Task 1: PUT /api/clients/:id (update client)

**Files:**
- Modify: `src/index.ts` — insert after the POST `/api/clients` block (ends line 214, before the `/api/jobs/...` toggle route at line 217)
- Modify: `test/api.test.ts` — extend mock env + add unit tests
- Modify: `test/integration.miniflare.test.ts` — add integration test

**Interfaces:**
- Consumes: `encryptPII`, `decryptPII`, `requireSecret`, `secretErrorResponse`, `corsHeaders` (all already in `src/index.ts`); mock env `createMockEnv()` from `test/api.test.ts`.
- Produces: route `PUT /api/clients/:id` → 200 `{success:true, clientId}` | 400 `{error:"Invalid JSON body"|"Missing required field: <field>"}` | 404 `{error:"Client not found"}`. Update writes all 20 client columns; job row untouched. Empty `passportNumber` string = keep existing ciphertext.

- [ ] **Step 1: Write failing unit tests**

Append to `test/api.test.ts` — first extend the mock. In `createMockEnv()`, replace the `first:` block (currently lines 20-28) with:

```ts
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
```

And in the `run:` block, add these two handlers before `return { success: true };` (after the existing `INSERT INTO jobs` handler):

```ts
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
```

Then append these tests at the end of the file:

```ts
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
```

- [ ] **Step 2: Run unit tests to verify they fail**

Run: `node --import tsx --test --test-name-pattern="PUT /api/clients" test/api.test.ts`
Expected: the 4 new tests FAIL (404/400/500 — route not implemented, mock handlers missing branch coverage).

- [ ] **Step 3: Implement the PUT route**

In `src/index.ts`, insert immediately after the closing `}` of the POST `/api/clients` block (line 214):

```ts
      // API: Update Client
      const putClientMatch = path.match(/\/api\/clients\/([^\/]+)$/);
      if (putClientMatch && request.method === "PUT") {
        const clientId = decodeURIComponent(putClientMatch[1]);
        const body: any = await request.json().catch(() => null);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const secret = requireSecret(env);
        if (!secret) return secretErrorResponse();

        const requiredFields = ["firstName", "lastName", "passportNumber", "passportExpiry", "dob",
          "email", "phone", "category", "familyNameAtBirth", "placeOfBirth", "countryOfBirth",
          "nationalityAtBirth", "street", "postalCode", "city", "passportIssueDate", "passportIssuingCountry"];
        const missing = requiredFields.find((f) => f === "passportNumber"
          ? typeof body[f] !== "string"
          : (typeof body[f] !== "string" || !body[f].trim()));
        if (missing) {
          return new Response(JSON.stringify({ error: `Missing required field: ${missing}` }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const existing = await env.DB.prepare("SELECT id FROM clients WHERE id = ?").bind(clientId).first();
        if (!existing) {
          return new Response(JSON.stringify({ error: "Client not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        // ponytail: empty passport = keep existing ciphertext; plaintext passport never re-sent to the browser
        let passportEnc: string;
        if (body.passportNumber.trim() === "") {
          const row = await env.DB.prepare("SELECT passport_number_enc FROM clients WHERE id = ?")
            .bind(clientId).first<any>();
          passportEnc = row?.passport_number_enc || "";
        } else {
          passportEnc = await encryptPII(body.passportNumber, secret);
        }

        const calendarId = body.category === "Master_PhD" ? 44279679 : 44281520;

        await env.DB.prepare(
          `UPDATE clients SET first_name_enc = ?, last_name_enc = ?, gender = ?, dob = ?, nationality = ?,
             passport_number_enc = ?, passport_expiry = ?, email_enc = ?, phone_enc = ?,
             family_name_at_birth_enc = ?, place_of_birth = ?, country_of_birth = ?,
             nationality_at_birth = ?, address_street_enc = ?, address_postal_code_enc = ?,
             address_city_enc = ?, passport_issue_date = ?, passport_issuing_country = ?,
             category = ?, calendar_id = ?
           WHERE id = ?`
        )
          .bind(
            await encryptPII(body.firstName, secret),
            await encryptPII(body.lastName, secret),
            body.gender || "Male",
            body.dob,
            body.nationality || "Egyptian",
            passportEnc,
            body.passportExpiry,
            await encryptPII(body.email, secret),
            await encryptPII(body.phone, secret),
            await encryptPII(body.familyNameAtBirth, secret),
            body.placeOfBirth,
            body.countryOfBirth,
            body.nationalityAtBirth,
            await encryptPII(body.street, secret),
            await encryptPII(body.postalCode, secret),
            await encryptPII(body.city, secret),
            body.passportIssueDate,
            body.passportIssuingCountry,
            body.category,
            calendarId,
            clientId
          )
          .run();

        return new Response(JSON.stringify({ success: true, clientId }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
```

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `node --import tsx --test --test-name-pattern="PUT /api/clients" test/api.test.ts`
Expected: 4 PASS.

- [ ] **Step 5: Write failing integration test (real D1 round-trip)**

Append to `test/integration.miniflare.test.ts`:

```ts
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
```

- [ ] **Step 6: Run integration test to verify it fails**

Run: `node --import tsx --test --test-name-pattern="PUT /api/clients" test/integration.miniflare.test.ts`
Expected: FAIL (route not yet in the bundled worker — if Task 1 Step 3 is done this may PASS; in that case proceed). If the bundle is stale, re-run the suite so `before()` rebuilds `.tmp-bundle`.

- [ ] **Step 7: Run full suites + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green, tsc clean.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts test/api.test.ts test/integration.miniflare.test.ts
git commit -m "feat: PUT /api/clients/:id full-field update with re-encryption and keep-passport semantics"
```

---

### Task 2: DELETE /api/clients/:id (hard delete + BOOKED guard)

**Files:**
- Modify: `src/index.ts` — insert after the PUT block from Task 1
- Modify: `test/api.test.ts` — add unit tests (mock handlers already added in Task 1)
- Modify: `test/integration.miniflare.test.ts` — add integration tests

**Interfaces:**
- Consumes: mock env with `first`/`run` branches from Task 1; `corsHeaders`.
- Produces: route `DELETE /api/clients/:id` → 200 `{success:true, clientId}` | 404 `{error:"Client not found"}` | 403 `{error:"BOOKED clients are protected from deletion"}`. Writes one audit row (`event_type='CLIENT_DELETED'`, `details=clientId`, no FK columns), then deletes the client (job cascades via FK).

- [ ] **Step 1: Write failing unit tests**

Append to `test/api.test.ts`:

```ts
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
```

Note: the mock's `createMockEnv()` return object currently lacks `logs` — extend it in this step:

```ts
    __stores: { clients: clientsStore, jobs: jobsStore, logs: logsStore }
```

- [ ] **Step 2: Run unit tests to verify they fail**

Run: `node --import tsx --test --test-name-pattern="DELETE /api/clients" test/api.test.ts`
Expected: FAIL (route not implemented).

- [ ] **Step 3: Implement the DELETE route**

Insert after the PUT block in `src/index.ts`:

```ts
      // API: Delete Client
      const delClientMatch = path.match(/\/api\/clients\/([^\/]+)$/);
      if (delClientMatch && request.method === "DELETE") {
        const clientId = decodeURIComponent(delClientMatch[1]);

        const existing = await env.DB.prepare("SELECT id FROM clients WHERE id = ?").bind(clientId).first();
        if (!existing) {
          return new Response(JSON.stringify({ error: "Client not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const job = await env.DB.prepare("SELECT id, status FROM jobs WHERE client_id = ?")
          .bind(clientId).first<any>();
        if (job && job.status === "BOOKED") {
          return new Response(JSON.stringify({ error: "BOOKED clients are protected from deletion" }), {
            status: 403,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        // ponytail: audit via details, not client_id FK — the client row is deleted next and would violate the FK
        await env.DB.prepare("INSERT INTO audit_logs (event_type, details) VALUES ('CLIENT_DELETED', ?)")
          .bind(clientId).run();
        await env.DB.prepare("DELETE FROM clients WHERE id = ?").bind(clientId).run();

        return new Response(JSON.stringify({ success: true, clientId }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
```

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `node --import tsx --test --test-name-pattern="DELETE /api/clients" test/api.test.ts`
Expected: 3 PASS.

- [ ] **Step 5: Write failing integration tests**

Append to `test/integration.miniflare.test.ts`:

```ts
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
```

- [ ] **Step 6: Run integration tests to verify they fail/pass**

Run: `node --import tsx --test --test-name-pattern="DELETE /api/clients" test/integration.miniflare.test.ts`
Expected: PASS (route exists from Step 3; if bundle is stale, `before()` rebuilds it).

- [ ] **Step 7: Run full suites + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts test/api.test.ts test/integration.miniflare.test.ts
git commit -m "feat: DELETE /api/clients/:id hard delete with BOOKED guard and CLIENT_DELETED audit"
```

---

### Task 3: GET /api/clients edit-prefill fields (email, phone, passportExpiry)

**Files:**
- Modify: `src/index.ts` — decrypt map in GET `/api/clients` (lines 89-116)
- Modify: `test/api.test.ts`, `test/integration.miniflare.test.ts`

**Interfaces:**
- Consumes: `decryptPII`.
- Produces: GET `/api/clients` items additionally carry `email: string`, `phone: string`, `passportExpiry: string`. `passportNumber` remains masked-only.

- [ ] **Step 1: Write failing test**

In `test/api.test.ts`, append:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test --test-name-pattern="edit-prefill" test/api.test.ts`
Expected: FAIL (`clients[0].email` undefined).

- [ ] **Step 3: Implement**

In `src/index.ts` GET `/api/clients` decrypt map, after the `nationality: c.nationality,` line (line 108), insert:

```ts
              email: await decryptPII(c.email_enc, secret),
              phone: await decryptPII(c.phone_enc, secret),
              passportExpiry: c.passport_expiry,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test --test-name-pattern="edit-prefill" test/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Extend the existing integration round-trip test**

In `test/integration.miniflare.test.ts`, in the test `"Integration: client creation encrypts PII at rest and returns masked data on read"` (line 129), after the `maskedPassport` assertion (line 183), add:

```ts
  assert.strictEqual(clients[0].email, "ahmed@example.com", "GET must decrypt email for edit prefill");
  assert.strictEqual(clients[0].phone, "+201000000000", "GET must decrypt phone for edit prefill");
  assert.strictEqual(clients[0].passportExpiry, "2030-01-01", "GET must return passport expiry for edit prefill");
```

- [ ] **Step 6: Run full suites + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts test/api.test.ts test/integration.miniflare.test.ts
git commit -m "feat: GET /api/clients returns email, phone, passportExpiry for edit prefill"
```

---

### Task 4: Dashboard assets + premium CSS (Bootstrap RTL, Alexandria, tokens, states)

**Files:**
- Modify: `src/index.ts` — `<head>` links (lines 467-476), `:root`/body CSS (lines 477-503), delete custom table/modal/form/button CSS blocks, add skeleton/empty-state/motion CSS
- Modify: `test/api.test.ts` — dashboard HTML assertions

**Interfaces:**
- Consumes: none (pure markup/CSS).
- Produces: dashboard HTML that loads `bootstrap.rtl.min.css` (SRI `sha384-CfCrinSRH2IR6a4e6fy2q6ioOX7O6Mtm1L9vRvFZ1trBncWmMePhzvafv7oIcWiW`), Alexandria + JetBrains Mono fonts, `data-bs-theme="dark"` on `<html>`, no custom `.btn`/table/modal/form CSS, skeleton + empty-state + reduced-motion CSS present.

- [ ] **Step 1: Write failing HTML assertions**

In `test/api.test.ts`, append:

```ts
test("Dashboard: premium assets and CRUD affordances are present, no alert() error popups", async () => {
  const env = createMockEnv();
  const res = await worker.fetch(new Request("https://opran-booking.local/"), env, {} as any);
  const html = await res.text();

  assert.ok(html.includes("bootstrap.rtl.min.css"), "Bootstrap RTL CSS must be loaded");
  assert.ok(html.includes("integrity=\"sha384-CfCrinSRH2IR6a4e6fy2q6ioOX7O6Mtm1L9vRvFZ1trBncWmMePhzvafv7oIcWiW"), "SRI hash must pin the Bootstrap file");
  assert.ok(html.includes("Alexandria"), "Premium Arabic font must be loaded");
  assert.ok(html.includes("data-bs-theme=\"dark\""), "Bootstrap dark theme must be set");
  assert.ok(html.includes("openEditModal"), "Edit affordance must exist");
  assert.ok(html.includes("deleteClient"), "Delete affordance must exist");
  assert.ok(html.includes("confirm("), "Delete must use native confirm()");
  assert.ok(html.includes("skeleton"), "Skeleton loading state must exist");
  assert.ok(html.includes("empty-state"), "Composed empty state must exist");
  assert.ok(!html.includes("فشل الحفظ"), "alert()-based form errors must be removed");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test --test-name-pattern="premium assets" test/api.test.ts`
Expected: FAIL.

- [ ] **Step 3: Head changes**

Replace line 468 and lines 473-475 in `src/index.ts`:

```html
<html lang="ar" dir="rtl" data-bs-theme="dark">
```

```html
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Alexandria:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.rtl.min.css" rel="stylesheet" integrity="sha384-CfCrinSRH2IR6a4e6fy2q6ioOX7O6Mtm1L9vRvFZ1trBncWmMePhzvafv7oIcWiW" crossorigin="anonymous">
```

- [ ] **Step 4: Replace the `:root` palette and body**

Replace lines 477-503 (the `:root { ... }`, `* { ... }`, and `body { ... }` blocks) with:

```css
    :root {
      --bg-surface: #0b0f1a;
      --bg-card: #111726;
      --bg-card-hover: #161e30;
      --border: rgba(148, 163, 184, 0.14);
      --border-accent: rgba(74, 125, 255, 0.35);
      --primary: #4a7dff;
      --primary-hover: #3b6ae6;
      --success: #2dd4a7;
      --success-bg: rgba(45, 212, 167, 0.12);
      --warning: #eab308;
      --warning-bg: rgba(234, 179, 8, 0.12);
      --danger: #f87171;
      --danger-bg: rgba(248, 113, 113, 0.12);
      --text: #e8edf6;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --shadow-card: 0 1px 0 rgba(255,255,255,0.04) inset, 0 12px 32px -16px rgba(3,7,18,0.9);
      --shadow-accent: 0 8px 24px -10px rgba(74, 125, 255, 0.45);
      /* Bootstrap dark-theme remap so .table/.btn/.alert/.form-control adopt our palette */
      --bs-body-bg: var(--bg-surface);
      --bs-body-color: var(--text);
      --bs-border-color: var(--border);
      --bs-primary: var(--primary);
      --bs-primary-rgb: 74, 125, 255;
      --bs-danger: var(--danger);
      --bs-danger-rgb: 248, 113, 113;
      --bs-secondary-color: var(--text-muted);
      --bs-table-striped-bg: rgba(255, 255, 255, 0.02);
      --bs-table-hover-bg: var(--bg-card-hover);
      --bs-modal-bg: var(--bg-card);
      --bs-modal-border-color: var(--border);
      --bs-btn-hover-bg: var(--primary-hover);
      --bs-btn-hover-border-color: var(--primary-hover);
      --bs-link-color: var(--primary);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background:
        radial-gradient(1100px 520px at 85% -10%, rgba(74, 125, 255, 0.10), transparent 60%),
        radial-gradient(900px 420px at 10% 110%, rgba(45, 212, 167, 0.05), transparent 60%),
        var(--bg-surface);
      color: var(--text);
      font-family: 'Alexandria', system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      padding: 24px;
      line-height: 1.6;
    }
    /* ponytail: one grain overlay instead of image assets — SVG noise, GPU-free */
    body::after {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 1;
      opacity: 0.035;
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/><feColorMatrix type='saturate' values='0'/></filter><rect width='160' height='160' filter='url(%23n)' opacity='0.5'/></svg>");
    }
    .container { max-width: 1400px; margin: 0 auto; position: relative; z-index: 2; }
    .metric-card, .header, .table-card {
      box-shadow: var(--shadow-card);
    }
    .btn, button { transition: transform 0.2s ease, background-color 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease; }
    .btn:active { transform: scale(0.98); }
    .btn:focus-visible, .form-control:focus, .form-select:focus { outline: 2px solid var(--primary); outline-offset: 2px; box-shadow: none; }
    .form-control, .form-select { background-color: #0d1117; border-color: var(--border); color: var(--text); }
    .form-control:focus, .form-select:focus { background-color: #0d1117; border-color: var(--primary); }
    .skeleton {
      background: linear-gradient(90deg, var(--bg-card) 25%, var(--bg-card-hover) 50%, var(--bg-card) 75%);
      background-size: 200% 100%;
      animation: shimmer 1.2s infinite;
    }
    @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
    .empty-state { text-align: center; padding: 48px 16px; }
    .empty-state .icon { font-size: 40px; margin-bottom: 12px; }
    @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    .metric-card { animation: rise 0.4s ease both; }
    .metric-card:nth-child(2) { animation-delay: 0.06s; }
    .metric-card:nth-child(3) { animation-delay: 0.12s; }
    .metric-card:nth-child(4) { animation-delay: 0.18s; }
    .metric-card.featured {
      grid-column: span 2;
      border: 1px solid var(--border-accent);
      box-shadow: var(--shadow-accent);
      background: linear-gradient(135deg, rgba(74, 125, 255, 0.08), transparent 60%), var(--bg-card);
    }
    @media (prefers-reduced-motion: reduce) {
      * { animation: none !important; transition: none !important; }
    }
```

- [ ] **Step 5: Delete the CSS blocks Bootstrap now owns**

Delete from `src/index.ts` these exact blocks:
- `.table-card { ... }`, `.table-header { ... }`, `.table-header h2 { ... }`, `table { ... }`, `th, td { ... }`, `th { ... }` (lines ~565-583)
- `.modal-backdrop { ... }` through `.modal-title { ... }` (lines ~595-619) — but KEEP `.modal-backdrop` (Bootstrap has no backdrop class without JS; keep ours): delete only `.modal { ... }` and `.modal-title { ... }` blocks
- `.form-grid { ... }`, `.form-group { ... }`, `.form-group input/select { ... }`, `.form-group input:focus... { ... }` (lines ~620-637)
- `.btn { ... }`, `.btn:hover { ... }`, `.btn-sm { ... }`, `.btn-secondary { ... }`, `.btn-secondary:hover { ... }` (lines ~535-550)

Keep: `.container`, `.header`, `.brand-*`, `.badge-*`, `.grid-metrics`, `.metric-*`, `.mono`, `.status-pill*`, `.table-wrapper`, media queries (but the media query at lines 638-666 references `.btn`/`.form-grid`/`.modal` — replace its `.btn`/`.form-grid`/`.modal` rules with `.btn { min-height: 44px; }` only, and delete `.form-grid`/`.modal` lines from it).

- [ ] **Step 6: Apply Bootstrap classes to markup**

In the dashboard body (same file):
- Table: `<table>` → `<table class="table table-striped table-hover align-middle mb-0">`
- Header button: `class="btn"` → `class="btn btn-primary"`
- Modal container div: `<div class="modal">` → `<div class="modal modal-content" style="max-width: 640px;">` (keep our backdrop div as-is)
- Modal title: `<div class="modal-title">إضافة مرشح جديد للنظام</div>` → `<div class="modal-title" id="client-modal-title">إضافة مرشح جديد للنظام</div>` + add a close button after it: `<button type="button" class="btn-close" aria-label="إغلاق" onclick="closeModal()"></button>`
- Wrap the `<form>` in `<div class="modal-body">` … `</div>` (open before the `<form>` tag, close after `</form>`), and move the two footer buttons (currently in the `<div style="display:flex; justify-content:flex-end; ...">`) into `<div class="modal-footer">` with classes `btn btn-outline-light` (إلغاء) and `btn btn-primary` (submit, `id="client-submit-btn"`).
- Every `<input ...>` gets `class="form-control"` added; every `<select ...>` gets `class="form-select"`.
- Delete the now-empty `<div class="form-grid">` wrappers or keep them for layout (keep — they only grid; Bootstrap doesn't conflict). Keep `.form-group` wrappers but their CSS was deleted — add `class="mb-3"` to each `.form-group` div instead (replace `class="form-group"` with `class="form-group mb-3"`).

- [ ] **Step 7: Run the HTML test to verify it passes**

Run: `node --import tsx --test --test-name-pattern="premium assets" test/api.test.ts`
Expected: PASS.

- [ ] **Step 8: Run full suites + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green (older dashboard tests still passing — verify the `admin form has new profile fields` test still matches; if `.form-group` replacement broke `id=` assertions, they must still pass since ids are untouched).

- [ ] **Step 9: Commit**

```bash
git add src/index.ts test/api.test.ts
git commit -m "style: premium dashboard — Bootstrap RTL CSS (SRI-pinned), Alexandria font, tinted tokens, grain, skeleton, motion"
```

---

### Task 5: CRUD UI wiring (edit mode, delete confirm, inline errors, skeleton/empty states)

**Files:**
- Modify: `src/index.ts` — modal JS, table row actions, loadDashboard

**Interfaces:**
- Consumes: GET `/api/clients` items (with Task 3 prefill fields), PUT/DELETE routes (Tasks 1-2), existing `toggleJob`.
- Produces: `openEditModal(clientId)`, `deleteClient(clientId)` global functions; edit mode reuses the add form; `window.__clients` holds the last loaded list; skeleton rows on first load; composed empty state.

- [ ] **Step 1: Replace the loading placeholder row**

In the table markup, replace:

```html
          <tbody id="client-rows">
            <tr>
              <td colspan="5" style="text-align: center; color: var(--text-muted);">جاري تحميل بيانات المرشحين...</td>
            </tr>
          </tbody>
```

with:

```html
          <tbody id="client-rows">
            <tr><td colspan="5"><div class="skeleton" style="height: 16px; border-radius: 4px;"></div></td></tr>
            <tr><td colspan="5"><div class="skeleton" style="height: 16px; border-radius: 4px;"></div></td></tr>
            <tr><td colspan="5"><div class="skeleton" style="height: 16px; border-radius: 4px;"></div></td></tr>
          </tbody>
```

- [ ] **Step 2: Make the active-candidates metric card featured**

Change `<div class="metric-card">` (the one containing `val-active`) to `<div class="metric-card featured">`.

- [ ] **Step 3: Rewrite the modal/table JS**

Replace the `<script>` block's `openModal`/`closeModal` definitions and the form submit handler and `loadDashboard` with:

```js
    let editingClientId = null;

    function openModal() {
      editingClientId = null;
      document.getElementById('client-modal-title').textContent = 'إضافة مرشح جديد للنظام';
      document.getElementById('client-submit-btn').textContent = 'حفظ وإنشاء المهمة';
      document.getElementById('passportNumber').placeholder = 'A12345678';
      document.getElementById('add-client-form').reset();
      document.getElementById('client-form-error').classList.add('d-none');
      document.getElementById('client-modal').style.display = 'flex';
    }
    function closeModal() { document.getElementById('client-modal').style.display = 'none'; }

    function openEditModal(clientId) {
      const c = (window.__clients || []).find(x => x.id === clientId);
      if (!c) return;
      editingClientId = clientId;
      document.getElementById('client-modal-title').textContent = 'تعديل بيانات المرشح';
      document.getElementById('client-submit-btn').textContent = 'حفظ التعديلات';
      const v = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ''; };
      v('firstName', c.firstName); v('lastName', c.lastName); v('category', c.category);
      v('familyNameAtBirth', c.familyNameAtBirth); v('placeOfBirth', c.placeOfBirth);
      v('countryOfBirth', c.countryOfBirth); v('nationalityAtBirth', c.nationalityAtBirth);
      v('street', c.street); v('postalCode', c.postalCode); v('city', c.city);
      v('passportIssueDate', c.passportIssueDate); v('passportIssuingCountry', c.passportIssuingCountry);
      v('passportNumber', '');
      document.getElementById('passportNumber').placeholder = 'اتركه فارغًا للإبقاء على الرقم الحالي';
      v('passportExpiry', c.passportExpiry); v('dob', c.dob); v('gender', c.gender);
      v('email', c.email); v('phone', c.phone);
      document.getElementById('client-form-error').classList.add('d-none');
      document.getElementById('client-modal').style.display = 'flex';
    }

    async function toggleJob(jobId, action) {
      await fetch('/api/jobs/' + jobId + '/' + action, { method: 'POST' });
      loadDashboard();
    }

    async function deleteClient(clientId) {
      if (!confirm('سيتم حذف المرشح ومهمته نهائيًا من النظام. هل أنت متأكد؟')) return;
      const res = await fetch('/api/clients/' + clientId, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        alert(err && err.error ? err.error : ('HTTP ' + res.status));
        return;
      }
      loadDashboard();
    }

    document.getElementById('add-client-form').onsubmit = async (e) => {
      e.preventDefault();
      const payload = {
        firstName: document.getElementById('firstName').value,
        lastName: document.getElementById('lastName').value,
        familyNameAtBirth: document.getElementById('familyNameAtBirth').value,
        placeOfBirth: document.getElementById('placeOfBirth').value,
        countryOfBirth: document.getElementById('countryOfBirth').value,
        nationalityAtBirth: document.getElementById('nationalityAtBirth').value,
        street: document.getElementById('street').value,
        postalCode: document.getElementById('postalCode').value,
        city: document.getElementById('city').value,
        passportIssueDate: document.getElementById('passportIssueDate').value,
        passportIssuingCountry: document.getElementById('passportIssuingCountry').value,
        category: document.getElementById('category').value,
        passportNumber: document.getElementById('passportNumber').value,
        passportExpiry: document.getElementById('passportExpiry').value,
        dob: document.getElementById('dob').value,
        gender: document.getElementById('gender').value,
        email: document.getElementById('email').value,
        phone: document.getElementById('phone').value,
        nationality: 'Egyptian'
      };
      const res = await fetch(editingClientId ? '/api/clients/' + editingClientId : '/api/clients', {
        method: editingClientId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        const box = document.getElementById('client-form-error');
        box.textContent = err && err.error ? err.error : ('HTTP ' + res.status);
        box.classList.remove('d-none');
        return;
      }
      closeModal();
      loadDashboard();
    };

    async function loadDashboard() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        document.getElementById('val-active').innerText = data.activeJobs + ' / 10';
        document.getElementById('val-cairo').innerText = data.cairoTime.formattedCairoTime + (data.cairoTime.isWithinWindow ? ' (داخل النافذة)' : ' (خارج النافذة)');
        document.getElementById('val-checks').innerText = data.metricsToday.total_checks || 0;
        document.getElementById('val-booked').innerText = data.metricsToday.bookings_completed || 0;

        const clientsRes = await fetch('/api/clients');
        const clients = await clientsRes.json();
        window.__clients = clients;
        const tbody = document.getElementById('client-rows');

        if (clients.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state"><div class="icon">📋</div><div style="font-weight: 700;">لا يوجد مرشحون بعد</div><div style="color: var(--text-muted); font-size: 13px; margin: 6px 0 16px;">أضف أول مرشح ليبدأ النظام بالفحص في نافذة 07:00 – 18:00</div><button class="btn btn-primary btn-sm" onclick="openModal()">+ إضافة مرشح جديد</button></div></td></tr>';
          return;
        }

        tbody.innerHTML = clients.map(c => \`
          <tr>
            <td style="font-weight: 700;">\${c.firstName} \${c.lastName}</td>
            <td>\${c.category === 'Master_PhD' ? 'ماجستير / دكتوراه' : 'بكالوريوس'}</td>
            <td><span class="mono">\${c.maskedPassport}</span></td>
            <td>
              \${c.status === 'CANCELLED'
                ? '<span class="status-pill status-paused">ملغي 🚫</span>'
                : c.status === 'BOOKED'
                  ? '<span class="status-pill status-active">تم الحجز ✅</span>'
                  : \`<span class="status-pill \${c.jobEnabled ? 'status-active' : 'status-paused'}">\${c.jobEnabled ? 'نشط ⚡' : 'متوقف ⏸'}</span>\`}
            </td>
            <td style="white-space: nowrap;">
              \${c.jobId && c.status !== 'CANCELLED' && c.status !== 'BOOKED' ? \`
                <button class="btn btn-sm btn-outline-light" onclick="toggleJob('\${c.jobId}', '\${c.jobEnabled ? 'pause' : 'activate'}')">
                  \${c.jobEnabled ? 'إيقاف مؤقت' : 'تفعيل'}
                </button>
                <button class="btn btn-sm btn-outline-light" onclick="openEditModal('\${c.id}')">تعديل</button>
                <button class="btn btn-sm btn-outline-danger" onclick="deleteClient('\${c.id}')">حذف</button>
                <button class="btn btn-sm btn-outline-danger" onclick="toggleJob('\${c.jobId}', 'cancel')">إلغاء</button>
              \` : ''}
            </td>
          </tr>
        \`).join('');
      } catch (err) {
        console.error('Failed to load dashboard:', err);
      }
    }
    loadDashboard();
    setInterval(loadDashboard, 10000);
```

- [ ] **Step 4: Add the inline error box to the modal**

Right after the modal title/close-button and before `<form id="add-client-form">`, insert:

```html
        <div class="alert alert-danger d-none" id="client-form-error" role="alert"></div>
```

- [ ] **Step 5: Run the dashboard HTML test**

Run: `node --import tsx --test --test-name-pattern="premium assets" test/api.test.ts`
Expected: PASS (assertions from Task 4 Step 1, including `!html.includes("فشل الحفظ")`).

- [ ] **Step 6: Run full suites + typecheck + dry-run build**

Run: `npm test && npm run typecheck && npx wrangler deploy --dry-run`
Expected: all green, bundle builds.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat: SPA edit/delete client actions with shared modal, inline errors, skeleton and empty states"
```

---

### Task 6: Verify, sync docs, deploy

**Files:**
- Modify: `docs/test-summary.md`, `Todo.md`, `docs/architecture.md` (API list only), `docs/implementation-artifacts/spec-spa-crud-premium-ui.md` (status → done)

**Interfaces:**
- Consumes: final code state from Tasks 1-5.

- [ ] **Step 1: Full verification**

Run: `npm test && npm run typecheck && npx wrangler deploy --dry-run`
Expected: all green. Record the final test counts from the `npm test` tail (lines `ℹ tests N`, `ℹ pass N`).

- [ ] **Step 2: Update docs/test-summary.md**

Update the status line and the checklist: replace the stale count with the recorded N, and add lines:
```
- [x] `PUT /api/clients/:id` — full-field update, re-encryption, empty-passport keeps existing ciphertext, calendar follows category (200/400/404).
- [x] `DELETE /api/clients/:id` — hard delete with job cascade, BOOKED guard (403), CLIENT_DELETED audit row (200/403/404).
- [x] `GET /api/clients` returns email/phone/passportExpiry for edit prefill; passport stays masked-only.
- [x] Dashboard: Bootstrap RTL CSS (SRI-pinned, CSS-only), Alexandria font, skeleton/empty/error states, edit + delete actions, native confirm().
```
Update the `ℹ tests`/`ℹ pass` code block with the real numbers.

- [ ] **Step 3: Update Todo.md**

In section 1 table, change the client-form row and add a row:
```
| نموذج العميل | ✅ **CRUD كامل 2026-08-20** | إضافة/تعديل/حذف + حقول ما قبل التعبئة + قفل BOOKED — Bootstrap RTL (CSS فقط) |
| لوحة المشغل (عربية) | ✅ **ترقية Premium** | Alexandria + Bootstrap RTL + skeleton/empty/inline errors — بلا أي تغيير على مسار الحجز |
```

- [ ] **Step 4: Update docs/architecture.md API list**

If `docs/architecture.md` lists endpoints, extend the list with `PUT /api/clients/:id` and `DELETE /api/clients/:id` (one line each, matching its table style). If it has no endpoint list, skip this step (do not invent a section).

- [ ] **Step 5: Mark the spec done**

In `docs/implementation-artifacts/spec-spa-crud-premium-ui.md` frontmatter: `status: 'done'`.

- [ ] **Step 6: Commit docs**

```bash
git add docs/test-summary.md Todo.md docs/architecture.md docs/implementation-artifacts/spec-spa-crud-premium-ui.md
git commit -m "docs: sync CRUD + premium UI status (tests, Todo, spec done)"
```

- [ ] **Step 7: Deploy (detached — never let a shell timeout kill the deploy)**

Run:

```bash
setsid nohup bash -c 'npx wrangler deploy' > /tmp/opencode/deploy-crud.log 2>&1 </dev/null & disown; sleep 25; tail -5 /tmp/opencode/deploy-crud.log
```

Expected: `Uploaded opran-booking ... Deployed opran-booking triggers ... Current Version ID: ...`

- [ ] **Step 8: Verify production**

Run (use the operator's existing Access Service Token values — obtain them from the operator, never store them in the repo):

```bash
curl -s https://opran-booking.maakebda.workers.dev/api/clients -H "CF-Access-Client-Id: <operator-client-id>.access" -H "CF-Access-Client-Secret: <operator-client-secret>" | head -c 300
```

Expected: 200 JSON with existing clients including `email`/`phone`/`passportExpiry` fields.

- [ ] **Step 9: Manual browser pass (operator)**

Open the dashboard, verify: RTL premium look, edit prefill + save, delete confirm + removal, skeleton on load, empty state, focus rings, no layout break on mobile width. Report any visual defect back to the agent.
