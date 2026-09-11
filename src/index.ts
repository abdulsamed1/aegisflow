import { scanAvailability, getSessionCookie, isTransportOutage } from "./scanner";
import { getCairoTimeInfo, getCairoDateString, rollingMondays, SCHEDULER_PICK_QUERY } from "./scheduler";
import { aggregateDailyReport, filterRowsByCairoDay, summarizePriorCairoDays, formatBadgeAndMessage } from "./daily-report";
import { sendTelegramNotification } from "./telegram";
import { JobLockDO } from "./lock";
import { encryptPII, decryptPII, maskPassport } from "./crypto";
import { DecryptedClientData } from "./booking-http";
import { executePlaywrightFallback } from "./browser-fallback";
import { isCircuitBreakerTripped } from "./backoff";
import { decideReverifyAction, decideRetryAction, buildSlotAlarmMessage, buildBookingStepMessage, getBookingFailureBackoffUntil } from "./booking-flow";
import { checkPreSubmitGate, CANONICAL_CALENDAR_ID } from "./pre-submit-gate";

export { JobLockDO };

export interface Env {
  DB: D1Database;
  JOB_LOCK: DurableObjectNamespace;
  SESSION_KV: KVNamespace;
  MYBROWSER: any;
  AI?: any;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  PII_ENCRYPTION_KEY?: string;
  ADMIN_API_KEY?: string;
  CAPTCHA_API_KEY?: string;
  ENVIRONMENT?: string;
  SCAN_BURSTS?: string;
  PLAN_TIER?: string;
}

//  tier-aware burst clamp — Free tier caps to 2 (<50 subrequests); Workers Paid caps to 12 (D5/FR-4)
export function parseScanBursts(v?: string, planTier?: string): number {
  const n = parseInt(v ?? "2", 10);
  const cap = typeof planTier === "string" && /paid/i.test(planTier) ? 12 : 2;
  return Number.isFinite(n) ? Math.min(cap, Math.max(1, n)) : 2;
}

function requireSecret(env: Env): string | null {
  return env.PII_ENCRYPTION_KEY || null;
}

function secretErrorResponse(): Response {
  return new Response(JSON.stringify({ error: "PII_ENCRYPTION_KEY not configured" }), {
    status: 500,
    headers: { "Content-Type": "application/json" }
  });
}

//  session cookie holds a keyed hash of ADMIN_API_KEY, never the raw key — cookie leak ≠ key leak
async function sessionToken(adminKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`aegisflow-session-v1|${adminKey}`)
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

// constant-time comparison — kills timing side-channel on secret compare
//  manual XOR loop — Node lacks crypto.subtle.timingSafeEqual, one portable impl
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS Headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // --- Authentication Middleware ---
      const isProduction = env.ENVIRONMENT === "production";
      if (isProduction && !env.ADMIN_API_KEY) {
        return new Response(JSON.stringify({ error: "ADMIN_API_KEY not configured in production" }), {
          status: 500, headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      //  no custom rate limiter — Access edge (layer 1) + 256-bit key entropy cover brute force
      let cookieToSet: string | null = null;

      if (env.ADMIN_API_KEY) {
        const key = env.ADMIN_API_KEY;
        const expectedSession = await sessionToken(key);
        const cookieMatch = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)__Host-aegisflow_admin_token=([^;]+)/);
        const cookieToken = cookieMatch ? cookieMatch[1] : null;

        let isAuthenticated = cookieToken !== null && safeEqual(cookieToken, expectedSession);
        let viaHeader = false;

        // Bearer or Basic (password = key, username ignored)
        const authHeader = request.headers.get("Authorization");
        if (!isAuthenticated && authHeader) {
          if (authHeader.startsWith("Bearer ")) {
            isAuthenticated = safeEqual(authHeader.substring(7), key);
          } else if (authHeader.startsWith("Basic ")) {
            try {
              const [_, pass] = atob(authHeader.substring(6)).split(":");
              isAuthenticated = safeEqual(pass, key);
            } catch (e) { }
          }
          if (isAuthenticated) viaHeader = true;
        }

        if (!isAuthenticated) {
          const apiKey = request.headers.get("X-API-Key");
          if (apiKey && safeEqual(apiKey, key)) {
            isAuthenticated = true;
            viaHeader = true;
          }
        }

        if (!isAuthenticated) {
          // If browser request (dashboard), prompt native Basic Auth
          if (request.method === "GET" && path === "/") {
            return new Response("Unauthorized", {
              status: 401,
              headers: {
                "WWW-Authenticate": 'Basic realm="aegisflow Booking Admin"',
                "Content-Type": "text/plain"
              }
            });
          }
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        //  browser logged in via header → upgrade to session cookie so the panel's fetch() is authenticated
        if (viaHeader) {
          cookieToSet = `__Host-aegisflow_admin_token=${expectedSession}; HttpOnly; Secure; Path=/; Max-Age=86400; SameSite=Strict`;
        }
      }
      // --- End Authentication Middleware ---

      // API: System Status & Metrics
      if (path === "/api/status" && request.method === "GET") {
        const cairo = getCairoTimeInfo();
        const activeJobsCount = await env.DB.prepare(
          "SELECT COUNT(*) as count FROM jobs WHERE enabled = 1 AND status = 'ACTIVE'"
        ).first<{ count: number }>();

        const metricsToday = await env.DB.prepare(
          "SELECT * FROM daily_metrics WHERE date = DATE('now')"
        ).first<any>() || { total_checks: 0, total_browser_seconds: 0.0, slots_found: 0, bookings_completed: 0 };

        const isTripped = isCircuitBreakerTripped(metricsToday.total_browser_seconds || 0.0);

        //  last-5 booking failures for the health tile — one bounded
        // query, no aggregation, no per-row Intl (client formats the clock).
        const { results: failureResults } = await env.DB.prepare(
          "SELECT job_id, client_id, event_type, details, created_at FROM audit_logs WHERE event_type IN ('BOOKING_FAILED','SLOT_GONE_PRE_LAUNCH','PRE_SUBMIT_BLOCKED','BOOKING_RETRY') ORDER BY created_at DESC LIMIT 5"
        ).all<any>();
        const recentFailures = (failureResults || []).slice(0, 5).map((r: any) => {
          let details: Record<string, any> = {};
          try { details = JSON.parse(r.details || "{}"); } catch { details = {}; }
          const week = details.week || details.matchedMonday || "";
          const { badge, message } = formatBadgeAndMessage(r.event_type, details, week, typeof details.attempt === "number" ? details.attempt : undefined);
          return { job_id: r.job_id, client_id: r.client_id, event_type: r.event_type, badge, message, created_at: r.created_at };
        });

        return new Response(
          JSON.stringify({
            status: isTripped ? "CIRCUIT_BREAKER_TRIPPED" : "operational",
            fastPathEnabled: true,
            circuitBreakerTripped: isTripped,
            cairoTime: cairo,
            activeJobs: activeJobsCount?.count || 0,
            metricsToday,
            recentFailures
          }),
          { headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }

      // API: List Clients
      if (path === "/api/clients" && request.method === "GET") {
        const secret = requireSecret(env);
        if (!secret) return secretErrorResponse();
        const { results } = await env.DB.prepare(
          `SELECT clients.*, jobs.id as job_id, jobs.status as job_status, jobs.enabled as job_enabled
           FROM clients
           LEFT JOIN jobs ON clients.id = jobs.client_id
           ORDER BY clients.created_at DESC`
        ).all();

        const decryptedClients = await Promise.all(
          (results || []).map(async (c: any) => {
            try {
              const passportDec = await decryptPII(c.passport_number_enc, secret);
              return {
                id: c.id,
                jobId: c.job_id,
                firstName: await decryptPII(c.first_name_enc, secret),
                lastName: await decryptPII(c.last_name_enc, secret),
                familyNameAtBirth: await decryptPII(c.family_name_at_birth_enc, secret),
                placeOfBirth: c.place_of_birth,
                countryOfBirth: c.country_of_birth,
                nationalityAtBirth: c.nationality_at_birth,
                street: await decryptPII(c.address_street_enc, secret),
                postalCode: await decryptPII(c.address_postal_code_enc, secret),
                city: await decryptPII(c.address_city_enc, secret),
                passportIssueDate: c.passport_issue_date,
                passportIssuingCountry: c.passport_issuing_country,
                gender: c.gender,
                dob: c.dob,
                nationality: c.nationality,
                email: await decryptPII(c.email_enc, secret),
                phone: await decryptPII(c.phone_enc, secret),
                passportExpiry: c.passport_expiry,
                maskedPassport: maskPassport(passportDec),
                category: c.category,
                calendarId: c.calendar_id,
                status: c.job_status || c.status,
                jobEnabled: Boolean(c.job_enabled),
                createdAt: c.created_at,
                decryptError: false
              };
            } catch {
              //  one row encrypted under a non-matching key must not 500
              // the whole ledger — flag it so the operator can repair (re-enter key
              // or delete + re-add the client) instead of staring at skeletons.
              return {
                id: c.id,
                jobId: c.job_id,
                firstName: "—",
                lastName: "تعذر فك التشفير",
                familyNameAtBirth: "",
                placeOfBirth: c.place_of_birth,
                countryOfBirth: c.country_of_birth,
                nationalityAtBirth: c.nationality_at_birth,
                street: "",
                postalCode: "",
                city: "",
                passportIssueDate: c.passport_issue_date,
                passportIssuingCountry: c.passport_issuing_country,
                gender: c.gender,
                dob: c.dob,
                nationality: c.nationality,
                email: "",
                phone: "",
                passportExpiry: c.passport_expiry,
                maskedPassport: "****",
                category: c.category,
                calendarId: c.calendar_id,
                status: c.job_status || c.status,
                jobEnabled: Boolean(c.job_enabled),
                createdAt: c.created_at,
                decryptError: true
              };
            }
          })
        );

        return new Response(JSON.stringify(decryptedClients), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // API: Add Client
      if (path === "/api/clients" && request.method === "POST") {
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
          "email", "phone", "category", "nationality", "familyNameAtBirth", "placeOfBirth", "countryOfBirth",
          "nationalityAtBirth", "street", "postalCode", "city", "passportIssueDate", "passportIssuingCountry"];
        const missing = requiredFields.find((f) => typeof body[f] !== "string" || !body[f].trim());
        if (missing) {
          return new Response(JSON.stringify({ error: `Missing required field: ${missing}` }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        if (body.category !== "Bachelor") {
          return new Response(JSON.stringify({ error: "Invalid category. Must be 'Bachelor'" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const clientId = `client_${Date.now()}`;

        const firstNameEnc = await encryptPII(body.firstName, secret);
        const lastNameEnc = await encryptPII(body.lastName, secret);
        const familyNameAtBirthEnc = await encryptPII(body.familyNameAtBirth, secret);
        const streetEnc = await encryptPII(body.street, secret);
        const postalCodeEnc = await encryptPII(body.postalCode, secret);
        const cityEnc = await encryptPII(body.city, secret);
        const passportEnc = await encryptPII(body.passportNumber, secret);
        const emailEnc = await encryptPII(body.email, secret);
        const phoneEnc = await encryptPII(body.phone, secret);

        const calendarId = CANONICAL_CALENDAR_ID;

        await env.DB.prepare(
          `INSERT INTO clients (id, first_name_enc, last_name_enc, gender, dob, nationality, passport_number_enc, passport_expiry, email_enc, phone_enc, family_name_at_birth_enc, place_of_birth, country_of_birth, nationality_at_birth, address_street_enc, address_postal_code_enc, address_city_enc, passport_issue_date, passport_issuing_country, category, calendar_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            clientId,
            firstNameEnc,
            lastNameEnc,
            body.gender || "Male",
            body.dob,
            body.nationality || "Egyptian",
            passportEnc,
            body.passportExpiry,
            emailEnc,
            phoneEnc,
            familyNameAtBirthEnc,
            body.placeOfBirth,
            body.countryOfBirth,
            body.nationalityAtBirth,
            streetEnc,
            postalCodeEnc,
            cityEnc,
            body.passportIssueDate,
            body.passportIssuingCountry,
            body.category,
            calendarId
          )
          .run();

        // Auto-create matching Job record
        //  legacy per-client columns written once with global constants — never read by the scheduler
        const jobId = `job_${Date.now()}`;
        const allDays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
        await env.DB.prepare(
          `INSERT INTO jobs (id, client_id, enabled, status, start_date, end_date, allowed_days, preferred_time_start, preferred_time_end)
           VALUES (?, ?, 1, 'ACTIVE', ?, ?, ?, ?, ?)`
        )
          .bind(
            jobId,
            clientId,
            new Date().toISOString().slice(0, 10),
            new Date(Date.now() + 8 * 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
            JSON.stringify(allDays),
            "07:00",
            "18:00"
          )
          .run();

        return new Response(JSON.stringify({ success: true, clientId, jobId }), {
          status: 201,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

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
          "email", "phone", "category", "nationality", "familyNameAtBirth", "placeOfBirth", "countryOfBirth",
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

        if (body.category !== "Bachelor") {
          return new Response(JSON.stringify({ error: "Invalid category. Must be 'Bachelor'" }), {
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

        //  empty passport = keep existing ciphertext; plaintext passport never re-sent to the browser
        let passportEnc: string;
        if (body.passportNumber.trim() === "") {
          const row = await env.DB.prepare("SELECT passport_number_enc FROM clients WHERE id = ?")
            .bind(clientId).first<any>();
          passportEnc = row?.passport_number_enc || "";
        } else {
          passportEnc = await encryptPII(body.passportNumber, secret);
        }

        const calendarId = CANONICAL_CALENDAR_ID;

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
        //  guard mid-flight booking — if DO lock is held/sealed, reject 423
        if (job) {
          try {
            const stRes = await env.JOB_LOCK.get(env.JOB_LOCK.idFromName(job.id)).fetch("https://lock/status");
            const st: any = await stRes.json();
            if (st.locked || st.sealed) {
              return new Response(JSON.stringify({ error: "Job is currently booking — deletion locked (423)" }), {
                status: 423,
                headers: { "Content-Type": "application/json", ...corsHeaders }
              });
            }
          } catch { }
        }

        //  detach scheduler audit rows first — they FK-reference the client and would block the delete
        await env.DB.prepare("UPDATE audit_logs SET client_id = NULL, job_id = NULL WHERE client_id = ?")
          .bind(clientId).run();

        //  audit via details, not client_id FK — the client row is deleted next and would violate the FK
        await env.DB.prepare("INSERT INTO audit_logs (event_type, details) VALUES ('CLIENT_DELETED', ?)")
          .bind(clientId).run();
        await env.DB.prepare("DELETE FROM clients WHERE id = ?").bind(clientId).run();

        return new Response(JSON.stringify({ success: true, clientId }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // API: Toggle Job Active/Pause Lifecycle
      if (path.match(/\/api\/jobs\/([^\/]+)\/(activate|pause|cancel)/) && request.method === "POST") {
        const match = path.match(/\/api\/jobs\/([^\/]+)\/(activate|pause|cancel)/);
        const jobId = match![1];
        const action = match![2];

        if (action === "activate") {
          await env.DB.prepare("UPDATE jobs SET enabled = 1, status = 'ACTIVE', backoff_until = NULL WHERE id = ?").bind(jobId).run();
        } else if (action === "pause") {
          await env.DB.prepare("UPDATE jobs SET enabled = 0, status = 'READY' WHERE id = ?").bind(jobId).run();
        } else if (action === "cancel") {
          await env.DB.prepare("UPDATE jobs SET enabled = 0, status = 'CANCELLED' WHERE id = ?").bind(jobId).run();
        }

        return new Response(JSON.stringify({ success: true, action, jobId }), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // API: Daily report —  Cairo-bucketed dedup + timeline + multi-day history
      if (path === "/api/daily-report" && request.method === "GET") {
        const dateParam = url.searchParams.get("date");
        let cairoDay = getCairoDateString(new Date());
        if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
          const d = new Date(dateParam + "T12:00:00Z");
          if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === dateParam) cairoDay = dateParam;
        }
        //  bulk scan-noise types (NO_APPOINTMENT, UNKNOWN_RESPONSE ≈100% of rows)
        // carry zero opportunity signal — summaries/history never read them. Selecting 8 days
        // of them cost ~2.6s CPU on 10k rows (per-row Intl + JSON.parse) and the platform
        // kills the isolate (HTTP 503 on the 10ms Free budget). Two bounded queries instead:
        // signal rows (rare types, all days) + UNKNOWN rows (selected Cairo day window only).
        // Cairo is UTC+2/+3, so [day-1, day+2) UTC strictly contains the Cairo day.
        const { results: signalResults } = await env.DB.prepare(
          "SELECT id, job_id, client_id, event_type, duration_ms, details, created_at FROM audit_logs WHERE created_at >= datetime('now', '-8 days') AND event_type NOT IN ('NO_APPOINTMENT','UNKNOWN_RESPONSE') ORDER BY created_at ASC"
        ).all<any>();
        const { results: unknownResults } = await env.DB.prepare(
          "SELECT id, job_id, client_id, event_type, duration_ms, details, created_at FROM audit_logs WHERE event_type = 'UNKNOWN_RESPONSE' AND created_at >= datetime(?, '-1 day') AND created_at < datetime(?, '+2 days') ORDER BY created_at ASC"
        ).bind(cairoDay, cairoDay).all<any>();
        const signalRows = signalResults || [];
        const unknownRows = unknownResults || [];
        //  both inputs arrive sorted — merge (not concat) keeps allRows chronological in O(n).
        const allRows: any[] = [];
        let i = 0, j = 0;
        while (i < signalRows.length || j < unknownRows.length) {
          if (j >= unknownRows.length || (i < signalRows.length && signalRows[i].created_at <= unknownRows[j].created_at)) allRows.push(signalRows[i++]);
          else allRows.push(unknownRows[j++]);
        }
        const cairoRows = filterRowsByCairoDay(allRows, cairoDay);
        const agg = aggregateDailyReport(cairoRows as any, cairoDay);
        const history = summarizePriorCairoDays(signalRows);
        return new Response(JSON.stringify({
          ...agg,
          history,
          limitation: "distinct per-slot count NOT derivable — scanner only reports grid non-empty (week granularity, see AD-4/G0 §5). Counting by job+week dedup; slot times within grid are not parsed. KAIRO SLOTS grid markup still UNVERIFIED (11.md #1/#5).",
          definition: "missed = APPOINTMENT_FOUND deduped by job+week on this Cairo day that later emitted SLOT_GONE_PRE_LAUNCH or non-transient BOOKING_FAILED without a BOOKED for same job+week (definition B).",
          timezone: "Africa/Cairo bucketing via getCairoDateString; audit_logs.created_at is UTC CURRENT_TIMESTAMP."
        }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
      }

      // API: Fetch Audit Logs (bounded; viewer filters signal client-side)
      if (path === "/api/logs" && request.method === "GET") {
        const rawLimit = parseInt(url.searchParams.get("limit") || "50", 10);
        const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, rawLimit)) : 50;
        const { results } = await env.DB.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?").bind(limit).all();
        return new Response(JSON.stringify((results || []).slice(0, limit)), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // Logout: clears the session cookie (full revocation = rotating ADMIN_API_KEY)
      if (path === "/logout" && request.method === "POST") {
        return new Response(JSON.stringify({ success: true }), {
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": "__Host-aegisflow_admin_token=; HttpOnly; Secure; Path=/; Max-Age=0; SameSite=Strict"
          }
        });
      }

      // Serve Single Operator Admin Panel HTML Dashboard
      return new Response(getAdminHTML(), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
          ...(cookieToSet ? { "Set-Cookie": cookieToSet } : {})
        }
      });
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext, now: Date = new Date()): Promise<void> {
    // Global Cairo operating window (D5 amended 2026-08-20): 07:00-18:00, every day incl. Friday.
    // Exit before any DB read — outside the window there is nothing to scan.
    if (!getCairoTimeInfo(now).isWithinWindow) return;

    // Circuit Breaker Check (NFR-2)
    const metricsToday = await env.DB.prepare(
      "SELECT * FROM daily_metrics WHERE date = DATE('now')"
    ).first<any>() || { total_browser_seconds: 0.0, budget_alert_sent: 0 };

    if (isCircuitBreakerTripped(metricsToday.total_browser_seconds || 0.0)) {
      console.warn(`Circuit breaker tripped (Daily browser budget ${metricsToday.total_browser_seconds}s >= 540s). Execution halted.`);
      if (!metricsToday.budget_alert_sent && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
        await sendTelegramNotification(
          env.TELEGRAM_BOT_TOKEN,
          env.TELEGRAM_CHAT_ID,
          `⚠️ *[CIRCUIT BREAKER ALERT]* Daily browser usage reached 90% threshold (${metricsToday.total_browser_seconds}s / 600s). Automation paused.`
        );
        await env.DB.prepare(
          "INSERT INTO daily_metrics (date, budget_alert_sent) VALUES (DATE('now'), 1) ON CONFLICT(date) DO UPDATE SET budget_alert_sent = 1"
        ).run();
      }
      return;
    }

    // Fair scheduler (AD-7): up to 3 oldest-outstanding jobs per tick
    const { results: jobs } = await env.DB.prepare(SCHEDULER_PICK_QUERY).all<any>();

    if (!jobs || jobs.length === 0) {
      return;
    }

    // Pre-fetch session cookie once for all parallel requests
    const sessionCookie = await getSessionCookie(env.SESSION_KV);

    // Rolling 8-week horizon (AD-11): current week + 7 forward weeks, same for every job.
    // Requests stay ACTIVE until booked or cancelled — there is no date-based expiry (D8).
    const mondays = rollingMondays();
    const bgTasks: Promise<any>[] = [];

    await Promise.all(jobs.map(async (job) => {
      // Hard invariant: Only Bachelor category and canonical calendar ID permitted (Bachelor-only lock)
      if (job.category !== "Bachelor" || job.calendar_id !== CANONICAL_CALENDAR_ID) {
        console.error(`[CRITICAL] Job ${job.id} skipped: Non-Bachelor category '${job.category}' or non-canonical calendar '${job.calendar_id}'`);
        return;
      }

      //  2×/min = every 30s coverage; 2*8*660*3 jobs ≈31k/day <200k free (Free cap 50 subrequests/invocation — 6× would exceed)
      const bursts = parseScanBursts(env.SCAN_BURSTS, env.PLAN_TIER);
      let slotResult: Awaited<ReturnType<typeof scanAvailability>> | undefined;
      let unknownResult: Awaited<ReturnType<typeof scanAvailability>> | undefined;
      let totalScanChecks = 0;
      let noSlotAggregated = 0;
      for (let b = 0; b < bursts; b++) {
        const scanResults = await Promise.all(mondays.map(m => scanAvailability(job.calendar_id, m, sessionCookie)));
        totalScanChecks += scanResults.length;
        for (const r of scanResults) {
          if (r.status === "NO_SLOTS") { noSlotAggregated++; continue; }
          const eventType = r.status === "SLOTS" ? "APPOINTMENT_FOUND" : "UNKNOWN_RESPONSE";
          bgTasks.push(env.DB.prepare(`INSERT INTO audit_logs (job_id, client_id, event_type, duration_ms, details) VALUES (?, ?, ?, ?, ?)`).bind(job.id, job.client_id, eventType, r.durationMs, JSON.stringify({ week: r.matchedMonday, responseLength: r.rawResponseLength, error: r.errorMessage, burst: b })).run());
        }
        const found = scanResults.find(r => r.status === "SLOTS");
        const unk = scanResults.find(r => r.status === "UNKNOWN");
        if (found) { slotResult = found; if (unk && !unknownResult) unknownResult = unk; break; }
        if (unk && !unknownResult) unknownResult = unk;
        // Portal-blackout backoff (prod 2026-09 520-storm): every fetch in this
        // burst died at transport, so remaining bursts cannot succeed. Skip them
        // (and the 30s inter-burst sleep): one aggregated row preserves the
        // signal instead of up to 8 rows per skipped burst. unknownResult above
        // still feeds jobs.last_error_code, so operator visibility is unchanged.
        if (!found && isTransportOutage(scanResults)) {
          bgTasks.push(env.DB.prepare(`INSERT INTO audit_logs (job_id, client_id, event_type, duration_ms, details) VALUES (?, ?, 'UNKNOWN_RESPONSE', ?, ?)`).bind(job.id, job.client_id, unk?.durationMs || 0, JSON.stringify({ aggregatedTransportFailures: scanResults.length, weeks: mondays.length, burstsSkipped: bursts - b - 1, error: unk?.errorMessage })).run());
          break;
        }
        if (b < bursts - 1) await new Promise(r => setTimeout(r, 30000));
      }
      if (noSlotAggregated) bgTasks.push(env.DB.prepare(`INSERT INTO audit_logs (job_id, client_id, event_type, duration_ms, details) VALUES (?, ?, 'NO_APPOINTMENT', 0, ?)`).bind(job.id, job.client_id, JSON.stringify({ aggregated: noSlotAggregated, bursts, weeks: mondays.length })).run());
      bgTasks.push(env.DB.prepare(`UPDATE jobs SET last_check = CURRENT_TIMESTAMP, check_count = check_count + ? WHERE id = ?`).bind(totalScanChecks, job.id).run());
      bgTasks.push(env.DB.prepare(`INSERT INTO daily_metrics (date, total_checks) VALUES (DATE('now'), ?) ON CONFLICT(date) DO UPDATE SET total_checks = total_checks + ?`).bind(totalScanChecks, totalScanChecks).run());
      if (slotResult) {
        bgTasks.push(env.DB.prepare(`INSERT INTO daily_metrics (date, slots_found) VALUES (DATE('now'), 1) ON CONFLICT(date) DO UPDATE SET slots_found = slots_found + 1`).run());
      } else if (unknownResult) {
        bgTasks.push(env.DB.prepare(`UPDATE jobs SET last_error_code = ? WHERE id = ?`).bind(unknownResult.errorMessage || "UNKNOWN_RESPONSE", job.id).run());
      }
      if (!slotResult) return;

      const slotMonday = slotResult.matchedMonday;
      const correlationId = `${job.id}-${slotMonday.replace(/[^a-zA-Z0-9]/g, '')}-${Date.now().toString(36)}`;
      console.log(`Slot detected for Job ${job.id} on week ${slotMonday} [correlationId: ${correlationId}]. Acquiring DO lock...`);

      const doId = env.JOB_LOCK.idFromName(job.id);
      const doStub = env.JOB_LOCK.get(doId);
      const lockRes = await doStub.fetch("https://lock/acquire");

      if (!lockRes.ok) {
        console.warn(`DO Lock rejected for Job ${job.id}: Lock already held.`);
        return;
      }

      const secret = requireSecret(env);
      if (!secret) {
        console.error("PII_ENCRYPTION_KEY not configured; releasing lock and aborting.");
        await doStub.fetch("https://lock/release");
        return;
      }

      const [
        firstName,
        lastName,
        familyNameAtBirth,
        street,
        postalCode,
        city,
        passportNumber,
        email,
        phone
      ] = await Promise.all([
        decryptPII(job.first_name_enc, secret),
        decryptPII(job.last_name_enc, secret),
        decryptPII(job.family_name_at_birth_enc, secret),
        decryptPII(job.address_street_enc, secret),
        decryptPII(job.address_postal_code_enc, secret),
        decryptPII(job.address_city_enc, secret),
        decryptPII(job.passport_number_enc, secret),
        decryptPII(job.email_enc, secret),
        decryptPII(job.phone_enc, secret)
      ]);

      const decryptedClient: DecryptedClientData = {
        id: job.client_id,
        firstName,
        lastName,
        familyNameAtBirth,
        placeOfBirth: job.place_of_birth,
        countryOfBirth: job.country_of_birth,
        nationalityAtBirth: job.nationality_at_birth,
        street,
        postalCode,
        city,
        passportIssueDate: job.passport_issue_date,
        passportIssuingCountry: job.passport_issuing_country,
        gender: job.gender,
        dob: job.dob,
        nationality: job.nationality,
        passportNumber,
        passportExpiry: job.passport_expiry,
        email,
        phone,
        category: job.category,
        calendarId: job.calendar_id
      };

      // Instant slot alarm (operator-parallel flow): fire BEFORE the reverify
      // scan so the operator can open the portal while the bot launches. Dedupe
      // per job+week in KV (30-min TTL) — slots re-detect every tick while live.
      if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
        const alarmKey = `slot_alarm:${job.id}:${slotMonday.replace(/[^a-zA-Z0-9]/g, "")}`;
        const alreadyAlarmed = env.SESSION_KV
          ? await env.SESSION_KV.get(alarmKey).catch(() => null)
          : null;
        if (!alreadyAlarmed) {
          bgTasks.push(sendTelegramNotification(
            env.TELEGRAM_BOT_TOKEN,
            env.TELEGRAM_CHAT_ID,
            buildSlotAlarmMessage({ jobId: job.id, clientName: firstName, week: slotMonday })
          ));
          if (env.SESSION_KV) bgTasks.push(env.SESSION_KV.put(alarmKey, "1", { expirationTtl: 1800 }).catch(() => null));
        }
      }

      //  re-verify slot before burning browser budget (step 4 latency gap)
      const reverify = await scanAvailability(job.calendar_id, slotMonday, sessionCookie);
      const reverifyAction = decideReverifyAction(reverify);
      if (reverifyAction !== "PROCEED") {
        console.warn(`[REVERIFY] Slot gone before Playwright for Job ${job.id}: ${reverify.status} — releasing lock without browser launch`);
        await doStub.fetch("https://lock/release");
        bgTasks.push(env.DB.prepare(
          `INSERT INTO audit_logs (job_id, client_id, event_type, duration_ms, details)
           VALUES (?, ?, 'SLOT_GONE_PRE_LAUNCH', ?, ?)`
        ).bind(job.id, job.client_id, reverify.durationMs, JSON.stringify({
          week: slotMonday,
          status: reverify.status,
          correlationId,
          attempt: 1,
          classification: "SLOT_GONE"
        })).run());
        if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
          bgTasks.push(sendTelegramNotification(
            env.TELEGRAM_BOT_TOKEN,
            env.TELEGRAM_CHAT_ID,
            buildBookingStepMessage("SLOT_GONE", { jobId: job.id, week: slotMonday, attempt: 1 })
          ));
        }
        return;
      }

      // Pre-submit gate: validate all required fields before burning browser budget
      const gate = checkPreSubmitGate(decryptedClient);
      if (!gate.ready) {
        console.error(`[PRE-SUBMIT GATE] BLOCKED for Job ${job.id}: ${gate.blockers.join("; ")}`);
        await doStub.fetch("https://lock/release");
        await env.DB.prepare(
          `UPDATE jobs SET status = 'ACTIVE', last_error_code = ? WHERE id = ?`
        ).bind(`PRE_SUBMIT_GATE: ${gate.blockers[0]}`, job.id).run();
        bgTasks.push(env.DB.prepare(
          `INSERT INTO audit_logs (job_id, client_id, event_type, details)
           VALUES (?, ?, 'PRE_SUBMIT_BLOCKED', ?)`
        ).bind(job.id, job.client_id, JSON.stringify({
          blockers: gate.blockers,
          correlationId,
          attempt: 1,
          classification: "VALIDATION_ERROR"
        })).run());
        if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
          bgTasks.push(sendTelegramNotification(
            env.TELEGRAM_BOT_TOKEN,
            env.TELEGRAM_CHAT_ID,
            buildBookingStepMessage("FAILED", { jobId: job.id, week: slotMonday, attempt: 1, classification: "VALIDATION_ERROR", error: gate.blockers.join("; ") })
          ));
        }
        return;
      }

      // Log booking start with correlation ID and attempt 1
      bgTasks.push(env.DB.prepare(
        `INSERT INTO audit_logs (job_id, client_id, event_type, duration_ms, details)
         VALUES (?, ?, 'BOOKING_STARTED', 0, ?)`
      ).bind(job.id, job.client_id, JSON.stringify({
        week: slotMonday,
        correlationId,
        attempt: 1
      })).run());

      // Playwright wizard is the single real booking path (London evidence: 31 fields, BDC_*, C65P dynamic)
      console.log(`[BOOKING] Launching Playwright wizard for Job ${job.id} week ${slotMonday} [attempt 1]`);
      if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
        bgTasks.push(sendTelegramNotification(
          env.TELEGRAM_BOT_TOKEN,
          env.TELEGRAM_CHAT_ID,
          buildBookingStepMessage("STARTED", { jobId: job.id, week: slotMonday, attempt: 1 })
        ));
      }
      let pwRes = await executePlaywrightFallback(env.MYBROWSER, decryptedClient, {
        startTime: slotMonday,
        captchaApiKey: env.CAPTCHA_API_KEY,
        ai: env.AI,
      });

      let totalBrowserSeconds = pwRes.durationSeconds;
      bgTasks.push(env.DB.prepare(
        `INSERT INTO daily_metrics (date, total_browser_seconds) VALUES (DATE('now'), ?)
         ON CONFLICT(date) DO UPDATE SET total_browser_seconds = total_browser_seconds + ?`
      ).bind(pwRes.durationSeconds, pwRes.durationSeconds).run());

      if (pwRes.submitted || pwRes.success) {
        bgTasks.push(env.DB.prepare(
          `INSERT INTO audit_logs (job_id, client_id, event_type, duration_ms, details)
           VALUES (?, ?, 'SUBMITTED', ?, ?)`
        ).bind(job.id, job.client_id, Math.round(pwRes.durationSeconds * 1000), JSON.stringify({
          week: slotMonday,
          slot: pwRes.selectedSlot,
          stage: pwRes.stageReached,
          correlationId,
          attempt: 1
        })).run());
        if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
          bgTasks.push(sendTelegramNotification(
            env.TELEGRAM_BOT_TOKEN,
            env.TELEGRAM_CHAT_ID,
            buildBookingStepMessage("SUBMITTED", { jobId: job.id, week: slotMonday, attempt: 1, stage: pwRes.stageReached, slot: pwRes.selectedSlot })
          ));
        }
      }

      if (pwRes.success && pwRes.referenceId) {
        console.log(`Booking completed for Job ${job.id}. Ref: ${pwRes.referenceId}`);
        await env.DB.prepare(
          `UPDATE jobs SET status = 'BOOKED' WHERE id = ? AND status = 'ACTIVE' AND enabled = 1`
        ).bind(job.id).run();
        await doStub.fetch("https://lock/seal");
        bgTasks.push(env.DB.prepare(
          `INSERT INTO daily_metrics (date, bookings_completed) VALUES (DATE('now'), 1)
           ON CONFLICT(date) DO UPDATE SET bookings_completed = bookings_completed + 1`
        ).run());
        if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
          bgTasks.push(sendTelegramNotification(
            env.TELEGRAM_BOT_TOKEN,
            env.TELEGRAM_CHAT_ID,
            `🎉 *[BOOKED] Appointment Secured!*\n\nClient: \`${decryptedClient.firstName} ${decryptedClient.lastName}\`\nPassport: \`${maskPassport(decryptedClient.passportNumber)}\`\nReference ID: \`${pwRes.referenceId}\`\nExecution Time: \`${Math.round(pwRes.durationSeconds * 1000)}ms\``
          ));
        }
        // lock sealed — no release
        bgTasks.push(env.DB.prepare(
          `INSERT INTO audit_logs (job_id, client_id, event_type, duration_ms, details)
           VALUES (?, ?, 'BOOKED', ?, ?)`
        ).bind(job.id, job.client_id, Math.round(pwRes.durationSeconds * 1000), JSON.stringify({
          referenceId: pwRes.referenceId,
          week: slotMonday,
          slot: pwRes.selectedSlot,
          stage: pwRes.stageReached,
          correlationId,
          attempt: 1
        })).run());
        return;
      }

      // First attempt failed — bounded retry: one re-scan + one more wizard launch if slot still there and breaker not tripped
      // Check breaker before retry (use current daily total + this attempt's seconds)
      const breakerTripped = isCircuitBreakerTripped((metricsToday.total_browser_seconds || 0) + totalBrowserSeconds);
      const rescanForRetry = await scanAvailability(job.calendar_id, slotMonday, sessionCookie);
      const retryDecision = decideRetryAction(pwRes, rescanForRetry, breakerTripped);

      if (retryDecision === "RETRY") {
        console.warn(`[RETRY] First booking failed for Job ${job.id} (${pwRes.errorMessage}) — slot still SLOTS, retrying once`);
        bgTasks.push(env.DB.prepare(
          `INSERT INTO audit_logs (job_id, client_id, event_type, duration_ms, details)
           VALUES (?, ?, 'BOOKING_RETRY', ?, ?)`
        ).bind(job.id, job.client_id, Math.round(pwRes.durationSeconds * 1000), JSON.stringify({
          error: pwRes.errorMessage,
          classification: pwRes.classification || "UNKNOWN",
          stage: pwRes.stageReached,
          slot: pwRes.selectedSlot,
          week: slotMonday,
          correlationId,
          attempt: 1
        })).run());
        if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
          bgTasks.push(sendTelegramNotification(
            env.TELEGRAM_BOT_TOKEN,
            env.TELEGRAM_CHAT_ID,
            buildBookingStepMessage("RETRY", { jobId: job.id, week: slotMonday, attempt: 1, classification: pwRes.classification, error: pwRes.errorMessage, stage: pwRes.stageReached })
          ));
        }

        bgTasks.push(env.DB.prepare(
          `INSERT INTO audit_logs (job_id, client_id, event_type, duration_ms, details)
           VALUES (?, ?, 'BOOKING_STARTED', 0, ?)`
        ).bind(job.id, job.client_id, JSON.stringify({
          week: slotMonday,
          correlationId,
          attempt: 2
        })).run());
        if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
          bgTasks.push(sendTelegramNotification(
            env.TELEGRAM_BOT_TOKEN,
            env.TELEGRAM_CHAT_ID,
            buildBookingStepMessage("STARTED", { jobId: job.id, week: slotMonday, attempt: 2 })
          ));
        }

        const pwRes2 = await executePlaywrightFallback(env.MYBROWSER, decryptedClient, {
          startTime: slotMonday,
          captchaApiKey: env.CAPTCHA_API_KEY,
          ai: env.AI,
        });
        totalBrowserSeconds += pwRes2.durationSeconds;
        bgTasks.push(env.DB.prepare(
          `INSERT INTO daily_metrics (date, total_browser_seconds) VALUES (DATE('now'), ?)
           ON CONFLICT(date) DO UPDATE SET total_browser_seconds = total_browser_seconds + ?`
        ).bind(pwRes2.durationSeconds, pwRes2.durationSeconds).run());

        if (pwRes2.submitted || pwRes2.success) {
          bgTasks.push(env.DB.prepare(
            `INSERT INTO audit_logs (job_id, client_id, event_type, duration_ms, details)
             VALUES (?, ?, 'SUBMITTED', ?, ?)`
          ).bind(job.id, job.client_id, Math.round(pwRes2.durationSeconds * 1000), JSON.stringify({
            week: slotMonday,
            slot: pwRes2.selectedSlot,
            stage: pwRes2.stageReached,
            correlationId,
            attempt: 2
          })).run());
          if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
            bgTasks.push(sendTelegramNotification(
              env.TELEGRAM_BOT_TOKEN,
              env.TELEGRAM_CHAT_ID,
              buildBookingStepMessage("SUBMITTED", { jobId: job.id, week: slotMonday, attempt: 2, stage: pwRes2.stageReached, slot: pwRes2.selectedSlot })
            ));
          }
        }

        if (pwRes2.success && pwRes2.referenceId) {
          console.log(`Booking completed on retry for Job ${job.id}. Ref: ${pwRes2.referenceId}`);
          await env.DB.prepare(
            `UPDATE jobs SET status = 'BOOKED' WHERE id = ? AND status = 'ACTIVE' AND enabled = 1`
          ).bind(job.id).run();
          await doStub.fetch("https://lock/seal");
          bgTasks.push(env.DB.prepare(
            `INSERT INTO daily_metrics (date, bookings_completed) VALUES (DATE('now'), 1)
             ON CONFLICT(date) DO UPDATE SET bookings_completed = bookings_completed + 1`
          ).run());
          if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
            bgTasks.push(sendTelegramNotification(
              env.TELEGRAM_BOT_TOKEN,
              env.TELEGRAM_CHAT_ID,
              `🎉 *[BOOKED] Appointment Secured (retry)!*\n\nClient: \`${decryptedClient.firstName} ${decryptedClient.lastName}\`\nPassport: \`${maskPassport(decryptedClient.passportNumber)}\`\nReference ID: \`${pwRes2.referenceId}\``
            ));
          }
          bgTasks.push(env.DB.prepare(
            `INSERT INTO audit_logs (job_id, client_id, event_type, duration_ms, details)
             VALUES (?, ?, 'BOOKED', ?, ?)`
          ).bind(job.id, job.client_id, Math.round(pwRes2.durationSeconds * 1000), JSON.stringify({
            referenceId: pwRes2.referenceId,
            week: slotMonday,
            slot: pwRes2.selectedSlot,
            stage: pwRes2.stageReached,
            retry: true,
            correlationId,
            attempt: 2
          })).run());
          return;
        }
        // Retry also failed — fall through to requeue with last error
        pwRes = pwRes2;
      }

      // Both attempts failed (or no retry) — re-queue ACTIVE with NO backoff
      // (never-park policy: check_count grows per scan tick, so any derived
      // backoff parks the job ~an hour; the job must stay tick-eligible while
      // slots verify — breaker/throttle/lock/reverify remain the guards).
      await doStub.fetch("https://lock/release");
      const backoffUntil = getBookingFailureBackoffUntil();
      await env.DB.prepare(
        `UPDATE jobs SET status = 'ACTIVE', backoff_until = ?, last_error_code = ? WHERE id = ?`
      ).bind(backoffUntil, pwRes.errorMessage || "BOOKING_FAILED", job.id).run();
      bgTasks.push(env.DB.prepare(
        `INSERT INTO audit_logs (job_id, client_id, event_type, duration_ms, details)
         VALUES (?, ?, 'BOOKING_FAILED', ?, ?)`
      ).bind(job.id, job.client_id, Math.round(totalBrowserSeconds * 1000), JSON.stringify({
        error: pwRes.errorMessage,
        classification: pwRes.classification || "UNKNOWN",
        stage: pwRes.stageReached,
        slot: pwRes.selectedSlot,
        week: slotMonday,
        totalBrowserSeconds,
        correlationId,
        attempt: retryDecision === "RETRY" ? 2 : 1
      })).run());
      if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
        bgTasks.push(sendTelegramNotification(
          env.TELEGRAM_BOT_TOKEN,
          env.TELEGRAM_CHAT_ID,
          buildBookingStepMessage("FAILED", { jobId: job.id, week: slotMonday, attempt: retryDecision === "RETRY" ? 2 : 1, classification: pwRes.classification, error: pwRes.errorMessage, stage: pwRes.stageReached, slot: pwRes.selectedSlot })
        ));
      }
    }));

    ctx.waitUntil(Promise.all(bgTasks));
  }
};

function getAdminHTML(): string {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl" data-theme="paper">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>نظام aegisflow لأتمتة الحجوزات — لوحة التحكم</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Alexandria:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    /* ===== Paper Dossier design system (hand-rolled, no framework CSS) =====
       v6: light editorial embassy case-file — parchment canvas, ink text, one
       burnt-red accent, ledger rules, zero shadows. Operator-directed per
       docs/ux-spec.md v6 (supersedes ClickHouse v5 near-black).
        JetBrains Mono dropped — system mono stack + tabular-nums
       (one fewer font request); textile weave is two static CSS gradients. */
    :root {
      --bg-surface: #f4efe6;        /* canvas: parchment */
      --bg-card: #fbf8f1;           /* surface-card: paper */
      --bg-card-hover: #efe8da;     /* paper in shadow */
      --bg-raised: #ffffff;         /* raised: modal/select surfaces */
      --border: #d8d0bf;            /* hairline: warm ledger rule */
      --border-strong: #b0a48c;     /* hairline-strong: input/modal borders read clearly */
      --border-accent: rgba(179, 58, 43, 0.35);
      --primary: #b33a2b;           /* burnt red — the one dossier stamp */
      --primary-hover: #992e21;     /* primary-active */
      --primary-ink: #fbf8f1;       /* paper text ON the red */
      --success: #1f7a4d; --success-bg: rgba(31, 122, 77, 0.09);
      --warning: #a15c07; --warning-bg: rgba(161, 92, 7, 0.10);
      --danger: #c0392b;  --danger-bg: rgba(192, 57, 43, 0.08);
      --text: #23201a; --text-muted: #4a4438; --text-dim: #8a8170; /* ink / body / muted-soft */
      --radius-card: 12px; --radius-control: 8px;
      --font-mono: ui-monospace, 'SF Mono', 'Cascadia Mono', Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg-surface);
      color: var(--text);
      font-family: 'Alexandria', system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      padding: 24px;
      line-height: 1.6;
    }
    body::before { /* paper weave — two static fibers, GPU-free, pointer-events none */
      content: ""; position: fixed; inset: 0; z-index: 0; pointer-events: none;
      background:
        repeating-linear-gradient(45deg, rgba(35,32,26,0.022) 0 1px, transparent 1px 5px),
        repeating-linear-gradient(-45deg, rgba(35,32,26,0.022) 0 1px, transparent 1px 5px);
    }
    .container { max-width: 1400px; margin: 0 auto; position: relative; z-index: 2; }

    /* ---- metric cards ---- */
    .grid-metrics {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 16px; margin-bottom: 22px;
    }
    .metric-card {
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: var(--radius-card); padding: 18px 20px;
      animation: rise 0.4s ease both;
    }
    .metric-card:nth-child(2) { animation-delay: 0.06s; }
    .metric-card:nth-child(3) { animation-delay: 0.12s; }
    .metric-card.featured {
      grid-column: span 2;
      background: var(--primary); border-color: var(--primary); /* the red band IS the signal */
    }
    .metric-card.featured .metric-label { color: rgba(251, 248, 241, 0.75); }
    .metric-card.featured .metric-val { color: var(--primary-ink); }
    .metric-label {
      font-size: 11px; color: var(--text-muted); font-weight: 600; letter-spacing: 0.05em;
      margin-bottom: 8px; display: flex; align-items: center; gap: 8px; text-transform: uppercase;
    }
    .metric-val { font-size: 28px; font-weight: 800; color: var(--text); line-height: 1.2; }
    .metric-val.mono, .mono {
      font-family: var(--font-mono); direction: ltr; display: inline-block;
      font-variant-numeric: tabular-nums;
    }
    .livetag {
      display: inline-flex; align-items: center; gap: 6px; font-size: 10px; font-weight: 700;
      color: var(--text-muted); letter-spacing: 0.05em; margin-top: 2px;
    }
    .livetag .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-dim); }

    /* ---- table card: ruled ledger ---- */
    .table-card {
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: var(--radius-card); overflow: hidden;
    }
    .table-header {
      display: flex; justify-content: space-between; align-items: center; padding: 16px 22px;
      border-bottom: 1px solid var(--border);
    }
    .table-header h2 { font-size: 15px; font-weight: 700; letter-spacing: -0.2px; }
    .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    table { width: 100%; border-collapse: collapse; min-width: 580px; }
    thead th {
      font-size: 11px; font-weight: 600; color: var(--text-dim); letter-spacing: 0.05em;
      text-align: right; padding: 12px 18px; border-bottom: 1px solid var(--border-strong);
      white-space: nowrap;
    }
    tbody td { padding: 13px 18px; font-size: 13.5px; border-bottom: 1px solid var(--border); }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:nth-child(even) { background: rgba(216, 208, 191, 0.16); } /* ledger alternation */
    tbody tr { transition: background-color 0.15s ease; }
    tbody tr:hover { background: var(--bg-card-hover); }
    .cell-name { font-weight: 700; }
    .cell-cat { color: var(--text-muted); font-size: 12.5px; }
    .cell-pid { font-family: var(--font-mono); direction: ltr; display: inline-block; color: var(--text-muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }

    .status-pill {
      display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px;
      border-radius: 999px; font-size: 11.5px; font-weight: 700; white-space: nowrap;
    }
    .status-active { background: var(--primary); color: var(--primary-ink); } /* solid red stamp */
    .status-paused { color: var(--text); border: 1.5px solid var(--border-strong); background: transparent; } /* ink stamp */
    .status-warn { color: var(--danger); border: 1.5px solid rgba(192,57,43,0.45); background: transparent; } /* corrupted-ciphertext flag */

    .row-actions { display: flex; gap: 8px; white-space: nowrap; }

    /* ---- buttons ---- */
    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      font-family: 'Alexandria', sans-serif; font-size: 13px; font-weight: 600;
      padding: 8px 14px; border-radius: var(--radius-control); border: 1px solid transparent;
      cursor: pointer; transition: transform 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
    }
    .btn:active { transform: scale(0.98); }
    .btn:focus-visible, .form-control:focus, .form-select:focus {
      outline: 2px solid var(--primary); outline-offset: 2px;
    }
    .btn-primary {
      background: var(--primary); color: var(--primary-ink); border-color: var(--primary);
    }
    .btn-primary:hover { background: var(--primary-hover); border-color: var(--primary-hover); }
    .btn-outline-light {
      background: transparent; color: var(--text); border-color: var(--border-strong);
    }
    .btn-outline-light:hover { background: var(--bg-card-hover); color: var(--text); }
    .btn-outline-danger { background: transparent; color: var(--danger); border-color: rgba(192,57,43,0.40); }
    .btn-outline-danger:hover { background: var(--danger-bg); }
    .btn-sm { padding: 5px 10px; font-size: 12px; }

    /* ---- modal ---- */
    .modal-backdrop {
      display: none; position: fixed; inset: 0; background: rgba(35, 32, 26, 0.45);
      backdrop-filter: blur(6px); z-index: 100; align-items: center; justify-content: center; padding: 16px;
    }
    .modal {
      width: 100%; max-width: 660px; max-height: 92vh; overflow-y: auto;
      background: var(--bg-raised); border: 1px solid var(--border-strong); border-radius: var(--radius-card);
      animation: rise 0.25s ease both;
    }
    .modal-head {
      display: flex; justify-content: space-between; align-items: center; gap: 12px;
      padding: 18px 22px; border-bottom: 1px solid var(--border);
    }
    .modal-title { font-size: 17px; font-weight: 800; letter-spacing: -0.2px; }
    .btn-close {
      background: transparent; border: 1px solid var(--border-strong); color: var(--text-muted);
      width: 30px; height: 30px; border-radius: 8px; font-size: 14px; cursor: pointer; line-height: 1;
    }
    .btn-close:hover { background: var(--bg-card-hover); color: var(--text); }
    .modal-body { padding: 20px 22px 22px; }

    .alert { padding: 10px 14px; border-radius: var(--radius-control); font-size: 13px; margin-bottom: 14px; }
    .alert-danger { background: var(--danger-bg); color: var(--danger); border: 1px solid rgba(192,57,43,0.30); }
    .d-none { display: none !important; }

    .global-rules {
      background: rgba(179, 58, 43, 0.06); border: 1px solid var(--border-accent);
      border-radius: var(--radius-control); padding: 12px 14px; font-size: 13px; color: var(--text-muted);
      margin-bottom: 16px; position: relative;
    }
    .global-rules::before {
      content: ""; position: absolute; inset-inline-start: 0; top: 8px; bottom: 8px; width: 3px;
      border-radius: 2px; background: var(--primary);
    }

    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px; }
    .form-group label { display: block; font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 6px; }
    .form-control, .form-select {
      width: 100%; background: var(--bg-raised); border: 1px solid var(--border-strong);
      border-radius: var(--radius-control); color: var(--text); font-family: 'Alexandria', sans-serif;
      font-size: 13.5px; padding: 9px 12px; transition: border-color 0.15s ease;
    }
    .form-control:focus, .form-select:focus {
      outline: none; border-color: var(--primary); /* text-input-focused: border turns red */
    }
    .form-select {
      appearance: none; -webkit-appearance: none;
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6'><path d='M1 1l4 4 4-4' stroke='%238a8170' stroke-width='1.5' fill='none' stroke-linecap='round'/></svg>");
      background-repeat: no-repeat; background-position: left 12px center; padding-inline-end: 28px;
    }
    input[type=date] { color-scheme: light; }
    .form-hint { font-size: 11.5px; color: var(--text-dim); margin-top: 4px; }

    .modal-footer {
      display: flex; justify-content: flex-start; gap: 10px; padding-top: 18px;
      border-top: 1px solid var(--border); margin-top: 18px;
    }

    /* ---- skeleton / empty ---- */
    .skeleton {
      background: linear-gradient(90deg, var(--bg-card) 25%, var(--bg-raised) 50%, var(--bg-card) 75%);
      background-size: 200% 100%; animation: shimmer 1.2s infinite; border-radius: 4px;
    }
    @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
    .empty-state { text-align: center; padding: 44px 16px; }
    .empty-state .icon {
      width: 52px; height: 52px; margin: 0 auto 14px; border-radius: var(--radius-card); font-size: 24px;
      display: grid; place-items: center; background: rgba(179,58,43,0.08);
      border: 1px solid rgba(179,58,43,0.25);
    }
    .empty-state .t { font-weight: 700; font-size: 15px; }
    .empty-state .d { color: var(--text-muted); font-size: 13px; margin: 6px 0 18px; }

    /* ---- footer ---- */
    @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    @media (prefers-reduced-motion: reduce) {
      * { animation: none !important; transition: none !important; }
    }
    @media (max-width: 768px) {
      body { padding: 12px; }
      .btn { min-height: 44px; }
      .grid-metrics { grid-template-columns: repeat(2, 1fr); gap: 10px; }
      .metric-card { padding: 14px; }
      .metric-label { font-size: 10.5px; }
      .metric-val { font-size: 22px; }
      .form-grid { grid-template-columns: 1fr; }
      .row-actions { flex-wrap: wrap; }
      .pill-btn { min-height: 44px; }
    }
    /* ---- bento ledger surface (v7): modular tiles, same dossier tokens ----
       No shadows, no decorative gradients, no glow — separation is hairlines
       and surface tone only. Accent stays on stamps/CTAs. */
    html { scroll-behavior: smooth; }
    .table-card { margin-bottom: 22px; }
    .table-header h2 { text-wrap: balance; letter-spacing: -0.02em; }
    .eyebrow { font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: var(--text-dim); text-transform: uppercase; margin-bottom: 2px; }
    .bento { display: grid; grid-template-columns: 7fr 5fr; gap: 0 16px; align-items: start; margin-bottom: 22px; }
    .bento > .table-card { margin-bottom: 0; min-width: 0; }
    #daily-report-card { position: relative; overflow: hidden; border-top: 3px solid var(--primary); } /* stamp rule, solid ink */
    /* ---- toasts: paper slips pinned to the corner ---- */
    #toasts { position: fixed; bottom: 20px; inset-inline-start: 20px; z-index: 200; display: flex; flex-direction: column; gap: 8px; max-width: min(360px, 90vw); }
    .toast { background: var(--bg-raised); border: 1px solid var(--border-strong); border-inline-start: 3px solid var(--primary); border-radius: var(--radius-control); padding: 10px 14px; font-size: 13px; display: flex; gap: 10px; align-items: center; animation: rise 0.2s ease both; }
    .toast-success { border-inline-start-color: var(--success); }
    .toast-error { border-inline-start-color: var(--danger); }
    .toast button { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 14px; line-height: 1; margin-inline-start: auto; }
    /* ---- audit ledger controls ---- */
    .audit-controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .audit-controls .form-select, .audit-controls .form-control { width: auto; }
    #audit-card tbody td.mono-time { font-family: var(--font-mono); direction: ltr; font-size: 12px; white-space: nowrap; }
    #audit-card thead th { position: sticky; top: 0; background: var(--bg-card); z-index: 1; }
    /* ---- folio numerals: dossier stamp numbering per tile ---- */
    .folio { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); margin-inline-end: 6px; }
    /* ---- filter pills ---- */
    .pill-btn { font-family: 'Alexandria', sans-serif; font-size: 12px; font-weight: 700; padding: 6px 12px; border-radius: 999px; border: 1.5px solid var(--border-strong); background: transparent; color: var(--text-muted); cursor: pointer; min-height: 32px; }
    .pill-btn[aria-pressed="true"] { background: var(--text); border-color: var(--text); color: var(--bg-card); }
    /* ---- budget ledger bar (thin progress, never a dial) ---- */
    .budget-bar { height: 8px; border-radius: 999px; background: rgba(35,32,26,0.10); overflow: hidden; margin-top: 10px; }
    .budget-fill { height: 100%; width: 100%; background: var(--primary); transform-origin: right; transform: scaleX(0); }
    @media (max-width: 1100px) {
      .bento { grid-template-columns: 1fr; gap: 22px; }
    }
    @media (max-width: 480px) {
      .grid-metrics { grid-template-columns: 1fr; }
    }
    @media (max-width: 640px) {
      #daily-report-card > div:nth-child(2) > div:nth-child(2) { grid-template-columns: 1fr !important; }
    }
  </style>
</head>
<body>
  <div class="container">

    <div class="grid-metrics">
      <div class="metric-card featured">
        <div class="metric-label">المرشحون النشطون</div>
        <div class="metric-val mono" id="val-active">-- / 10</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">فحوصات اليوم</div>
        <div class="metric-val mono" id="val-checks">0</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">الحجوزات الناجحة</div>
        <div class="metric-val mono" style="color: var(--success);" id="val-booked">0</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">ميزانية المتصفح اليوم</div>
        <div class="metric-val mono" id="budget-text" style="font-size:22px;">— / 600s</div>
        <div class="budget-bar" role="img" aria-label="استهلاك ميزانية المتصفح اليومية"><div class="budget-fill" id="budget-fill"></div></div>
        <div id="budget-state" style="font-size:11px; color:var(--text-muted); margin-top:6px;">—</div>
      </div>
    </div>

    <!-- Daily Report — Paper Dossier: Cairo-day dedup, Arabic-first disclosure -->
    <section class="table-card" id="daily-report-card" aria-labelledby="daily-report-title">
      <div class="table-header" style="flex-wrap:wrap; gap:12px;">
        <div><div class="eyebrow"><span class="folio">٠١</span>تقرير القاهرة اليومي</div><h2 id="daily-report-title">التقرير اليومي — المواعيد المرصودة</h2></div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <label for="report-date" style="font-size:12px; font-weight:700; color:var(--text-muted);">اليوم (القاهرة)</label>
          <input id="report-date" class="form-control" type="date" style="width:auto; min-width:170px;" aria-label="اختر يوم التقرير بتوقيت القاهرة">
          <button class="btn btn-outline-light btn-sm" id="report-reload" type="button" onclick="loadDailyReport()">تحديث</button>
          <span class="livetag" style="margin-inline-start:4px;"><span class="dot" style="background:var(--success);"></span> Africa/Cairo</span>
        </div>
      </div>
      <div style="padding:18px 22px; background:var(--bg-card);">
        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin-bottom:14px;">
          <div class="metric-card" style="padding:16px 14px; display:flex; flex-direction:column; gap:8px;">
            <div class="metric-label">حالة اليوم</div>
            <div id="rep-was-open" style="display:inline-flex; align-items:center; gap:6px; font-size:13px; font-weight:800; min-height:28px;" aria-live="polite">—</div>
            <div style="font-size:11px; color:var(--text-dim); line-height:1.4;">هل رُصدت أي مواعيد؟</div>
          </div>
          <div class="metric-card" style="padding:16px 14px;">
            <div class="metric-label">أسابيع بها مواعيد <span title="فرص مميزة: كل مهمة+أسبوع تُحسب مرة واحدة في اليوم مهما تكرر الفحص" style="cursor:help; border-bottom:1px dotted var(--border-strong);">ⓘ</span></div>
            <div class="metric-val mono" id="rep-found">—</div>
            <div style="font-size:11px; color:var(--text-dim); margin-top:4px;">مميزة في اليوم</div>
          </div>
          <div class="metric-card" style="padding:16px 14px;">
            <div class="metric-label">تم حجزها</div>
            <div class="metric-val mono" style="color:var(--success);" id="rep-booked">—</div>
            <div style="font-size:11px; color:var(--text-dim); margin-top:4px;">تحولت إلى حجز</div>
          </div>
          <div class="metric-card" style="padding:16px 14px;">
            <div class="metric-label">فرص ضائعة</div>
            <div class="metric-val mono" style="color:var(--danger);" id="rep-missed">—</div>
            <div style="font-size:11px; color:var(--text-dim); margin-top:4px;">فُقدت بعد الرصد</div>
          </div>
          <div class="metric-card" style="padding:16px 14px;">
            <div class="metric-label">أخطاء تقنية مؤقتة</div>
            <div class="metric-val mono" style="color:var(--warning);" id="rep-technical">—</div>
            <div style="font-size:11px; color:var(--text-dim); margin-top:4px;">انقطاع دون ضياع المقعد</div>
          </div>
        </div>
        <div id="rep-missed-details" role="status" aria-live="polite" style="font-size:13px; color:var(--text-muted); min-height:22px; margin-bottom:18px;"></div>
        <!-- Multi-Day Cairo History -->
        <div style="margin-top: 24px; padding-top: 18px; border-top: 1px solid var(--border-subtle);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px;">
            <h3 style="font-size:14px; font-weight:700; margin:0;">سجل الأيام السابقة (بتوقيت القاهرة)</h3>
            <span style="font-size:11px; color:var(--text-dim);">تغطية 8 أيام سابقة من audit_logs</span>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>تاريخ اليوم</th>
                  <th>حالة المواعيد</th>
                  <th>أسابيع مرصودة</th>
                  <th>تم حجزها</th>
                  <th>فرص ضائعة</th>
                  <th>أخطاء تقنية</th>
                  <th>الإجراء</th>
                </tr>
              </thead>
              <tbody id="history-rows">
                <tr><td colspan="7" style="text-align:center; color:var(--text-dim); padding:16px;">جاري تحميل السجل التاريخي...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>

    <div class="bento">
    <section class="table-card" aria-labelledby="clients-title">
      <div class="table-header" style="flex-wrap:wrap; gap:12px;">
        <div><div class="eyebrow"><span class="folio">٠٢</span>سجل المرشحين</div><h2 id="clients-title">قائمة مرشحي الحجز</h2></div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <span class="livetag" style="margin:0;"><span class="dot"></span><span class="txt">تحديث تلقائي 10 ثوانٍ</span></span>
          <button class="btn btn-outline-light btn-sm" id="logout-btn" type="button" onclick="logout()">تسجيل الخروج</button>
          <button class="btn btn-primary btn-sm" id="add-client-btn" type="button" onclick="openModal()">+ إضافة مرشح جديد</button>
        </div>
      </div>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding:12px 22px; border-bottom:1px solid var(--border);">
        <input id="client-search" class="form-control" type="search" placeholder="بحث بالاسم أو الجواز…" aria-label="بحث في المرشحين" style="max-width:220px;">
        <div id="client-pills" role="group" aria-label="تصفية حسب حالة المهمة" style="display:flex; gap:6px; flex-wrap:wrap;">
          <button type="button" class="pill-btn" data-status="" aria-pressed="true">الكل</button>
          <button type="button" class="pill-btn" data-status="active" aria-pressed="false">نشط</button>
          <button type="button" class="pill-btn" data-status="paused" aria-pressed="false">متوقف</button>
          <button type="button" class="pill-btn" data-status="booked" aria-pressed="false">محجوز</button>
          <button type="button" class="pill-btn" data-status="cancelled" aria-pressed="false">ملغي</button>
        </div>
        <span id="client-count" class="mono" style="margin-inline-start:auto; font-size:12px; color:var(--text-muted);"></span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>اسم المرشح</th>
              <th>الفئة</th>
              <th>جواز السفر (مشفّر)</th>
              <th>حالة المهمة</th>
              <th>الإجراءات</th>
            </tr>
          </thead>
          <tbody id="client-rows">
            <tr><td colspan="5"><div class="skeleton" style="height: 16px;"></div></td></tr>
            <tr><td colspan="5"><div class="skeleton" style="height: 16px;"></div></td></tr>
            <tr><td colspan="5"><div class="skeleton" style="height: 16px;"></div></td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="table-card" id="audit-card" aria-labelledby="audit-title">
      <div class="table-header" style="flex-wrap:wrap; gap:12px;">
        <div><div class="eyebrow"><span class="folio">٠٣</span>سجل النظام</div><h2 id="audit-title">أحداث التدقيق المباشرة</h2></div>
        <div class="audit-controls">
          <select id="audit-type" class="form-select" aria-label="تصفية حسب نوع الحدث"><option value="signal" selected>الأحداث المهمة فقط</option><option value="">كل الأحداث</option></select>
          <input id="audit-search" class="form-control" type="search" placeholder="بحث…" aria-label="بحث في السجل" style="max-width:150px;">
          <button class="btn btn-outline-light btn-sm" id="audit-refresh" type="button" onclick="loadAudit()">تحديث</button>
        </div>
      </div>
      <div class="table-wrap" style="max-height:380px; overflow-y:auto;">
        <table style="min-width:480px;">
          <thead>
            <tr>
              <th style="width:90px;">الوقت</th>
              <th style="width:150px;">الحدث</th>
              <th>التفاصيل</th>
            </tr>
          </thead>
          <tbody id="audit-rows">
            <tr><td colspan="3" style="text-align:center; color:var(--text-dim); padding:20px;">جاري تحميل السجل...</td></tr>
          </tbody>
        </table>
      </div>
    </section>
    </div>

    <section class="table-card" aria-labelledby="health-title">
      <div class="table-header">
        <div><div class="eyebrow"><span class="folio">٠٤</span>صحة الحجز · Africa/Cairo</div><h2 id="health-title">أعطال الحجز الأخيرة</h2></div>
        <span class="livetag" style="margin:0;"><span class="dot"></span>آخر 5 أحداث فاشلة</span>
      </div>
      <div class="table-wrap">
        <table style="min-width:520px;">
          <thead>
            <tr>
              <th style="width:90px;">الوقت</th>
              <th style="width:150px;">الحدث</th>
              <th>السبب</th>
              <th style="width:110px;">المهمة</th>
            </tr>
          </thead>
          <tbody id="health-rows">
            <tr><td colspan="4" style="text-align:center; color:var(--text-dim); padding:20px;">جاري تحميل الأعطال...</td></tr>
          </tbody>
        </table>
      </div>
    </section>

  </div>

  <div id="toasts" aria-live="polite"></div>

  <!-- Modal -->
  <div class="modal-backdrop" id="client-modal">
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title" id="client-modal-title">إضافة مرشح جديد للنظام</div>
        <button type="button" class="btn-close" aria-label="إغلاق" onclick="closeModal()">✕</button>
      </div>
      <div class="modal-body">
        <div class="alert alert-danger d-none" id="client-form-error" role="alert"></div>
      <form id="add-client-form">
        <div class="form-grid">
          <div class="form-group">
            <label>الاسم الأول</label>
            <input class="form-control" type="text" id="firstName" required placeholder="أحمد">
          </div>
          <div class="form-group">
            <label>اسم العائلة</label>
            <input class="form-control" type="text" id="lastName" required placeholder="حسن">
          </div>
        </div>
        <div class="form-group">
          <label>فئة الحجز</label>
          <select class="form-select" id="category">
            <option value="Bachelor">بكالوريوس / تعليم جامعي</option>
          </select>
        </div>
        <div class="global-rules">
          ⏰ قواعد المواعيد موحّدة لجميع الطلبات: الفحص يوميًا من 07:00 حتى 18:00 بتوقيت القاهرة، والطلب يبقى نشطًا حتى إتمام الحجز أو الإلغاء.
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>اسم العائلة عند الميلاد</label>
            <input class="form-control" type="text" id="familyNameAtBirth" required>
          </div>
          <div class="form-group">
            <label>مكان الميلاد</label>
            <input class="form-control" type="text" id="placeOfBirth" required placeholder="القاهرة">
          </div>
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>بلد الميلاد</label>
            <input class="form-control" type="text" id="countryOfBirth" required placeholder="مصر">
          </div>
          <div class="form-group">
            <label>الجنسية عند الميلاد</label>
            <input class="form-control" type="text" id="nationalityAtBirth" required placeholder="مصري">
          </div>
        </div>
        <div class="form-group">
          <label>الشارع / العنوان</label>
          <input class="form-control" type="text" id="street" required placeholder="١٢ شارع التحرير">
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>الرمز البريدي</label>
            <input class="form-control" type="text" id="postalCode" required placeholder="11511" style="direction: ltr;">
          </div>
          <div class="form-group">
            <label>المدينة</label>
            <input class="form-control" type="text" id="city" required placeholder="القاهرة">
          </div>
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>رقم جواز السفر</label>
            <input class="form-control" type="text" id="passportNumber" required placeholder="A12345678" style="direction: ltr;">
          </div>
          <div class="form-group">
            <label>تاريخ انتهاء الجواز</label>
            <input class="form-control" type="date" id="passportExpiry" required>
          </div>
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>تاريخ إصدار الجواز</label>
            <input class="form-control" type="date" id="passportIssueDate" required>
          </div>
          <div class="form-group">
            <label>جهة إصدار الجواز</label>
            <input class="form-control" type="text" id="passportIssuingCountry" required placeholder="مصر">
          </div>
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>تاريخ الميلاد</label>
            <input class="form-control" type="date" id="dob" required>
          </div>
          <div class="form-group">
            <label>النوع</label>
            <select class="form-select" id="gender">
              <option value="Male">ذكر</option>
              <option value="Female">أنثى</option>
            </select>
          </div>
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>البريد الإلكتروني</label>
            <input class="form-control" type="email" id="email" required placeholder="client@example.com" style="direction: ltr;">
          </div>
          <div class="form-group">
            <label>رقم الهاتف</label>
            <input class="form-control" type="tel" id="phone" required placeholder="+201000000000" style="direction: ltr;">
          </div>
        </div>
        <div class="form-group">
          <label>الجنسية (للتقديم)</label>
          <input class="form-control" type="text" id="nationality" required placeholder="Egyptian" value="Egyptian">
          <div class="form-hint">القيمة المرسلة لحقل NationalityForApplication في البوابة — "Egyptian" للمصريين</div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-outline-light" onclick="closeModal()">إلغاء</button>
          <button type="submit" class="btn btn-primary" id="client-submit-btn">حفظ وإنشاء المهمة</button>
        </div>
      </form>
      </div>
    </div>
  </div>
  <script>
    let editingClientId = null;

    function openModal() {
      editingClientId = null;
      document.getElementById('client-modal-title').textContent = 'إضافة مرشح جديد للنظام';
      document.getElementById('client-submit-btn').textContent = 'حفظ وإنشاء المهمة';
      document.getElementById('passportNumber').placeholder = 'A12345678';
      document.getElementById('passportNumber').required = true;
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
      document.getElementById('passportNumber').required = false;
      v('passportExpiry', c.passportExpiry); v('dob', c.dob); v('gender', c.gender);
      v('email', c.email); v('phone', c.phone);
      v('nationality', c.nationality);
      document.getElementById('client-form-error').classList.add('d-none');
      document.getElementById('client-modal').style.display = 'flex';
    }

    async function toggleJob(jobId, action) {
      try {
        var res = await fetch('/api/jobs/' + jobId + '/' + action, { method: 'POST' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        toast('تم تحديث حالة المهمة بنجاح', 'success');
        loadDashboard();
      } catch (err) {
        toast('تعذر تحديث المهمة: ' + (err && err.message ? err.message : err), 'error');
      }
    }

    async function deleteClient(clientId) {
      if (!confirm('سيتم حذف المرشح ومهمته نهائيًا من النظام. هل أنت متأكد؟')) return;
      const res = await fetch('/api/clients/' + clientId, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast(err && err.error ? err.error : ('HTTP ' + res.status), 'error');
        return;
      }
      toast('تم حذف المرشح نهائيًا', 'success');
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
        nationality: document.getElementById('nationality').value || 'Egyptian'
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
        toast(box.textContent, 'error');
        return;
      }
      closeModal();
      toast(editingClientId ? 'تم حفظ التعديلات بنجاح' : 'تمت إضافة المرشح وإنشاء مهمته', 'success');
      loadDashboard();
    };

    function escapeHtml(s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, function(c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }

    var lastToastKey = null;
    var lastToastEl = null;
    function toast(msg, kind, dedupeKey) {
      var box = document.getElementById("toasts");
      if (!box) return;
      //  10s polling must not stack identical failure slips — one visible slip per cause.
      if (dedupeKey && dedupeKey === lastToastKey && lastToastEl && lastToastEl.isConnected) return;
      var el = document.createElement("div");
      el.className = "toast" + (kind === "success" ? " toast-success" : kind === "error" ? " toast-error" : "");
      var span = document.createElement("span");
      span.textContent = msg;
      var x = document.createElement("button");
      x.textContent = "✕";
      x.setAttribute("aria-label", "إغلاق التنبيه");
      x.onclick = function() { el.remove(); };
      el.appendChild(span);
      el.appendChild(x);
      //  single visible slip — a new toast replaces the old one (ux-feedback).
      while (box.firstChild) box.firstChild.remove();
      box.appendChild(el);
      if (dedupeKey) { lastToastKey = dedupeKey; lastToastEl = el; }
      setTimeout(function() { el.remove(); }, 3000);
    }

    //  surface the server's own error message (500 bodies name the cause —
    // without this the UI can only report the downstream TypeError, hiding the culprit).
    async function fetchJSON(url) {
      var res = await fetch(url);
      if (!res.ok) {
        var body = await res.json().catch(function() { return null; });
        throw new Error("HTTP " + res.status + (body && body.error ? ": " + body.error : ""));
      }
      return res.json();
    }

    async function logout() {
      try { await fetch("/logout", { method: "POST" }); } catch (e) {}
      window.location.reload();
    }

    var auditTimeFmt = null;
    try {
      auditTimeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    } catch (e) {}
    function auditTime(iso) {
      try {
        var d = new Date((iso || "").replace(" ", "T") + "Z");
        if (Number.isNaN(d.getTime())) return "—";
        return auditTimeFmt ? auditTimeFmt.format(d) : d.toISOString().slice(11, 19);
      } catch (e) { return "—"; }
    }
    function auditMessage(r) {
      var det = {};
      try { det = JSON.parse(r.details || "{}"); } catch (e) {}
      return det.error || det.week || det.referenceId || r.job_id || r.client_id || "—";
    }
    var SIGNAL_DEFAULT = "signal";
    var NOISE_TYPES = { NO_APPOINTMENT: true, UNKNOWN_RESPONSE: true };
    function renderAudit() {
      var sel = document.getElementById("audit-type");
      var q = (document.getElementById("audit-search").value || "").trim();
      var rows = window.__audit || [];
      var known = {};
      rows.forEach(function(r) { known[r.event_type] = true; });
      var cur = sel.value || SIGNAL_DEFAULT;
      sel.innerHTML = '<option value="signal">الأحداث المهمة فقط</option><option value="">كل الأحداث</option>' + Object.keys(known).sort().map(function(t) {
        return '<option value="' + t + '"' + (t === cur ? " selected" : "") + ">" + t + "</option>";
      }).join("");
      var out = rows.filter(function(r) {
        if (cur === SIGNAL_DEFAULT && NOISE_TYPES[r.event_type]) return false;
        if (cur && cur !== SIGNAL_DEFAULT && r.event_type !== cur) return false;
        if (q && JSON.stringify(r).indexOf(q) === -1) return false;
        return true;
      }).slice(0, 50);
      var tb = document.getElementById("audit-rows");
      if (!out.length) {
        tb.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:24px;"><div class="empty-state" style="padding:12px;"><div class="t">لا توجد أحداث مطابقة</div><div class="d">جرّب توسيع التصفية أو تحديث السجل</div><button class="btn btn-outline-light btn-sm" onclick="loadAudit()">تحديث السجل</button></div></td></tr>';
        return;
      }
      tb.innerHTML = out.map(function(r) {
        return '<tr><td class="mono-time">' + auditTime(r.created_at) + '</td><td><span class="status-pill status-paused">' + escapeHtml(r.event_type) + '</span></td><td style="font-size:12.5px;">' + escapeHtml(auditMessage(r)) + "</td></tr>";
      }).join("");
    }
    async function loadAudit() {
      try {
        window.__audit = await fetchJSON("/api/logs?limit=200");
        renderAudit();
      } catch (err) {
        toast("تعذر تحميل سجل التدقيق: " + (err && err.message ? err.message : err), "error", "audit");
      }
    }
    document.getElementById("audit-type").addEventListener("change", renderAudit);
    document.getElementById("audit-search").addEventListener("input", renderAudit);

    async function loadDashboard() {
      try {
        const data = await fetchJSON('/api/status');
        document.getElementById('val-active').innerText = data.activeJobs + ' / 10';
        document.getElementById('val-checks').innerText = data.metricsToday.total_checks || 0;
        document.getElementById('val-booked').innerText = data.metricsToday.bookings_completed || 0;

        const clients = await fetchJSON('/api/clients');
        window.__clients = clients;
        renderClients();
        renderBudget(data.metricsToday, data.circuitBreakerTripped);
        renderHealth(data.recentFailures || []);
      } catch (err) {
        console.error('Failed to load dashboard:', err);
        toast('تعذر تحديث اللوحة: ' + (err && err.message ? err.message : err), 'error', 'dash');
        var failBody = document.getElementById('client-rows');
        if (failBody) failBody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:24px;"><div class="empty-state" style="padding:12px;"><div class="t">تعذر تحميل المرشحين</div><div class="d">' + escapeHtml(err && err.message ? err.message : err) + '</div><button class="btn btn-outline-light btn-sm" onclick="loadDashboard()">إعادة المحاولة</button></div></td></tr>';
      }
    }

    window.__clientFilter = window.__clientFilter || { q: '', status: '' };
    function clientStatus(c) {
      if (c.status === 'CANCELLED') return 'cancelled';
      if (c.status === 'BOOKED') return 'booked';
      return c.jobEnabled ? 'active' : 'paused';
    }
    function clearClientFilter() {
      window.__clientFilter = { q: '', status: '' };
      var s = document.getElementById('client-search');
      if (s) s.value = '';
      var pills = document.querySelectorAll('#client-pills .pill-btn');
      pills.forEach(function(p) { p.setAttribute('aria-pressed', p.getAttribute('data-status') === '' ? 'true' : 'false'); });
      renderClients();
    }
    function renderClients() {
      var clients = window.__clients || [];
      var f = window.__clientFilter;
      var q = (f.q || '').trim();
      var list = clients.filter(function(c) {
        if (f.status && clientStatus(c) !== f.status) return false;
        if (q) {
          var hay = ((c.firstName || '') + ' ' + (c.lastName || '') + ' ' + (c.maskedPassport || '') + ' ' + (c.category || ''));
          if (hay.indexOf(q) === -1) return false;
        }
        return true;
      });
      var count = document.getElementById('client-count');
      if (count) count.textContent = 'عرض ' + list.length + ' من ' + clients.length;
      var tbody = document.getElementById('client-rows');
      if (!clients.length) {
          tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state"><div class="icon">📋</div><div style="font-weight: 700;">لا يوجد مرشحون بعد</div><div style="color: var(--text-muted); font-size: 13px; margin: 6px 0 16px;">أضف أول مرشح ليبدأ النظام بالفحص في نافذة 07:00 – 18:00</div><button class="btn btn-primary btn-sm" onclick="openModal()">+ إضافة مرشح جديد</button></div></td></tr>';
          return;
        }

      if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:24px;"><div class="empty-state" style="padding:12px;"><div class="t">لا توجد نتائج مطابقة</div><div class="d">جرّب توسيع البحث أو تصفية مختلفة</div><button class="btn btn-outline-light btn-sm" onclick="clearClientFilter()">مسح التصفية</button></div></td></tr>';
        return;
      }
      tbody.innerHTML = list.map(c => \`
          <tr>
            <td style="font-weight: 700;">\${c.firstName} \${c.lastName}</td>
            <td>\${c.category === 'Master_PhD' ? 'ماجستير / دكتوراه' : 'بكالوريوس'}</td>
            <td><span class="mono">\${c.maskedPassport}</span></td>
            <td>
              \${c.decryptError ? '<span class="status-pill status-warn">تعذر فك التشفير ⚠</span>' : ''}
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

    }
    function renderBudget(metrics, tripped) {
      var secs = Math.round((metrics && metrics.total_browser_seconds) || 0);
      document.getElementById('budget-text').textContent = secs + ' / 600s';
      document.getElementById('budget-fill').style.transform = 'scaleX(' + Math.min(1, secs / 600) + ')';
      var st = document.getElementById('budget-state');
      if (tripped) { st.textContent = 'القاطع مفصول — توقف الفحص'; st.style.color = 'var(--danger)'; }
      else if (secs >= 480) { st.textContent = 'اقتراب من الحد'; st.style.color = 'var(--warning)'; }
      else { st.textContent = 'طبيعي'; st.style.color = 'var(--text-muted)'; }
    }
    function renderHealth(list) {
      var tb = document.getElementById('health-rows');
      if (!tb) return;
      if (!list.length) {
        tb.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--text-muted); padding:20px;">لا أعطال حديثة — مسار الحجز سليم</td></tr>';
        return;
      }
      tb.innerHTML = list.map(function(f) {
        return '<tr><td class="mono-time">' + auditTime(f.created_at) + '</td><td><span class="status-pill status-paused">' + escapeHtml(f.event_type) + '</span></td><td style="font-size:12.5px;">' + escapeHtml(f.message) + '</td><td class="mono" style="font-size:11px; direction:ltr;">' + escapeHtml((f.job_id || '?').slice(0, 12)) + '</td></tr>';
      }).join('');
    }
    document.getElementById('client-search').addEventListener('input', function(e) {
      window.__clientFilter.q = e.target.value || '';
      renderClients();
    });
    document.getElementById('client-pills').addEventListener('click', function(e) {
      var btn = e.target.closest ? e.target.closest('.pill-btn') : null;
      if (!btn) return;
      window.__clientFilter.status = btn.getAttribute('data-status') || '';
      var pills = document.querySelectorAll('#client-pills .pill-btn');
      pills.forEach(function(p) { p.setAttribute('aria-pressed', p === btn ? 'true' : 'false'); });
      renderClients();
    });

    async function loadDailyReport(dateOverride) {
      const input = document.getElementById('report-date');
      //  default to Cairo today via Intl en-CA, no dep
      const cairoToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
      const date = dateOverride || (input && input.value) || cairoToday;
      if (input) input.value = date;
      const elWas = document.getElementById('rep-was-open');
      const elFound = document.getElementById('rep-found');
      const elBooked = document.getElementById('rep-booked');
      const elMissed = document.getElementById('rep-missed');
      const elTechnical = document.getElementById('rep-technical');
      const elDetails = document.getElementById('rep-missed-details');
      const elHistory = document.getElementById('history-rows');
      if (!elWas) return;
      elWas.innerHTML = '<span class="skeleton" style="display:inline-block; width:110px; height:20px;"></span>';
      elFound.textContent = '…'; elBooked.textContent = '…'; elMissed.textContent = '…';
      if (elTechnical) elTechnical.textContent = '…';
      elDetails.textContent = '';
      if (elHistory) elHistory.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-dim); padding:16px;">جاري تحميل السجل التاريخي...</td></tr>';
      try {
        const d = await fetchJSON('/api/daily-report?date=' + encodeURIComponent(date));
        elWas.innerHTML = d.was_open
          ? '<span class="status-pill status-active">مفتوحة — رُصدت مواعيد ✓</span>'
          : '<span class="status-pill status-paused">مغلقة — لا مواعيد</span>';
        elFound.textContent = String(d.opportunities_found ?? 0);
        elBooked.textContent = String(d.opportunities_booked ?? 0);
        elMissed.textContent = String(d.opportunities_missed ?? 0);
        if (elTechnical) elTechnical.textContent = String(d.technical_failures ?? 0);
        if (d.missed_details && d.missed_details.length) {
          elDetails.innerHTML = '<span style="font-weight:700; color:var(--text);">الفرص الضائعة:</span> ' + d.missed_details.map(function(m){
            var w = (m.week||'?').replace(' 12:00:00 AM','');
            return '<span style="display:inline-flex; align-items:center; gap:6px; margin:4px 6px 0 0; padding:4px 10px; background:var(--danger-bg); border:1px solid rgba(192,57,43,0.22); border-radius:999px; font-size:11.5px;"><span class="mono" style="direction:ltr;">' + w + '</span><span style="color:var(--text-dim);">·</span><span class="mono" style="direction:ltr; font-size:10px;">' + (m.job_id||'?').slice(0,8) + '</span></span>';
          }).join('');
        } else {
          elDetails.textContent = d.was_open ? 'لا توجد فرص ضائعة بهذا التعريف لهذا اليوم — كل ما رُصد تم حَجزه أو لا يزال قيد المحاولة.' : 'لم تُرصد أي شبكة أسبوع بها مواعيد في هذا اليوم بتوقيت القاهرة.';
          elDetails.style.color = 'var(--text-dim)';
        }

        // Render Multi-day History
        if (elHistory) {
          if (d.history && d.history.length) {
            elHistory.innerHTML = d.history.map(function(h){
              var statusPill = h.was_open
                ? '<span class="status-pill status-active">مفتوحة ✓</span>'
                : '<span class="status-pill status-paused">مغلقة</span>';
              var isSelected = h.date === date;
              var rowBg = isSelected ? 'background: rgba(179,58,43,0.06); font-weight:700;' : '';
              return '<tr style="' + rowBg + '">' +
                '<td class="mono" style="direction:ltr;">' + h.date + (isSelected ? ' (الحالي)' : '') + '</td>' +
                '<td>' + statusPill + '</td>' +
                '<td class="mono">' + h.opportunities_found + '</td>' +
                '<td class="mono" style="color:var(--success);">' + h.opportunities_booked + '</td>' +
                '<td class="mono" style="color:var(--danger);">' + h.opportunities_missed + '</td>' +
                '<td class="mono" style="color:var(--warning);">' + h.technical_failures + '</td>' +
                '<td><button class="btn btn-outline-light btn-sm" onclick="loadDailyReport(\\'' + h.date + '\\'' + ')">عرض هذا اليوم</button></td>' +
              '</tr>';
            }).join('');
          } else {
            elHistory.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-dim); padding:16px;">لا توجد سجلات للأيام السابقة.</td></tr>';
          }
        }
      } catch (err) {
        elDetails.textContent = 'تعذر تحميل التقرير: ' + (err && err.message ? err.message : err);
        elDetails.style.color = 'var(--danger)';
        toast(elDetails.textContent, 'error', 'report');
      }
    }
    document.getElementById('report-date')?.addEventListener('change', function(e){ loadDailyReport(e.target.value); });

    loadDashboard();
    loadDailyReport();
    loadAudit();
    setInterval(loadDashboard, 10000);
    setInterval(loadAudit, 10000);
  </script>
</body>
</html>`;
}

