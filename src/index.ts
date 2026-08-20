import { scanAvailability, getSessionCookie } from "./scanner";
import { getCairoTimeInfo, rollingMondays, SCHEDULER_PICK_QUERY } from "./scheduler";
import { sendTelegramNotification } from "./telegram";
import { JobLockDO } from "./lock";
import { encryptPII, decryptPII, maskPassport } from "./crypto";
import { executeDirectHttpBooking, DecryptedClientData } from "./booking-http";
import { executePlaywrightFallback } from "./browser-fallback";
import { isCircuitBreakerTripped, getBackoffUntilISO } from "./backoff";

export { JobLockDO };

export interface Env {
  DB: D1Database;
  JOB_LOCK: DurableObjectNamespace;
  SESSION_KV: KVNamespace;
  MYBROWSER: any;
  DRY_RUN: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  PII_ENCRYPTION_KEY?: string;
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS Headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
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

        return new Response(
          JSON.stringify({
            status: isTripped ? "CIRCUIT_BREAKER_TRIPPED" : "operational",
            fastPathEnabled: true,
            dryRun: env.DRY_RUN === "true",
            circuitBreakerTripped: isTripped,
            cairoTime: cairo,
            activeJobs: activeJobsCount?.count || 0,
            metricsToday
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
              createdAt: c.created_at
            };
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
          "email", "phone", "category", "familyNameAtBirth", "placeOfBirth", "countryOfBirth",
          "nationalityAtBirth", "street", "postalCode", "city", "passportIssueDate", "passportIssuingCountry"];
        const missing = requiredFields.find((f) => typeof body[f] !== "string" || !body[f].trim());
        if (missing) {
          return new Response(JSON.stringify({ error: `Missing required field: ${missing}` }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        if (body.category !== "Bachelor" && body.category !== "Master_PhD") {
          return new Response(JSON.stringify({ error: "Invalid category. Must be 'Bachelor' or 'Master_PhD'" }), {
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

        const calendarId = body.category === "Master_PhD" ? 44279679 : 44281520;

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
        // ponytail: legacy per-client columns written once with global constants — never read by the scheduler
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

        if (body.category !== "Bachelor" && body.category !== "Master_PhD") {
          return new Response(JSON.stringify({ error: "Invalid category. Must be 'Bachelor' or 'Master_PhD'" }), {
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

        // ponytail: detach scheduler audit rows first — they FK-reference the client and would block the delete
        await env.DB.prepare("UPDATE audit_logs SET client_id = NULL, job_id = NULL WHERE client_id = ?")
          .bind(clientId).run();

        // ponytail: audit via details, not client_id FK — the client row is deleted next and would violate the FK
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

      // API: Fetch Audit Logs
      if (path === "/api/logs" && request.method === "GET") {
        const { results } = await env.DB.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 50").all();
        return new Response(JSON.stringify(results || []), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // Serve Single Operator Admin Panel HTML Dashboard
      return new Response(getAdminHTML(), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
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
      // Parallelize 8-week scan for this job
      const scanPromises = mondays.map(mondayStr => scanAvailability(job.calendar_id, mondayStr, sessionCookie));
      const scanResults = await Promise.all(scanPromises);

      // We only care if we found a slot, or track the first unknown error if all fail
      const slotResult = scanResults.find(r => r.status === "SLOTS");
      const unknownResult = scanResults.find(r => r.status === "UNKNOWN");
      
      // Background DB Logging
      bgTasks.push(env.DB.prepare(
        `UPDATE jobs SET last_check = CURRENT_TIMESTAMP, check_count = check_count + 8 WHERE id = ?`
      ).bind(job.id).run());
      
      bgTasks.push(env.DB.prepare(
        `INSERT INTO daily_metrics (date, total_checks) VALUES (DATE('now'), 8)
         ON CONFLICT(date) DO UPDATE SET total_checks = total_checks + 8`
      ).run());
      
      // Log all scan results
      for (const result of scanResults) {
        const eventType = result.status === "SLOTS" ? "APPOINTMENT_FOUND" : result.status === "UNKNOWN" ? "UNKNOWN_RESPONSE" : "NO_APPOINTMENT";
        bgTasks.push(env.DB.prepare(
          `INSERT INTO audit_logs (job_id, client_id, event_type, duration_ms, details)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(job.id, job.client_id, eventType, result.durationMs, JSON.stringify({ week: result.matchedMonday, responseLength: result.rawResponseLength, error: result.errorMessage })).run());
      }

      if (slotResult) {
        bgTasks.push(env.DB.prepare(
          `INSERT INTO daily_metrics (date, slots_found) VALUES (DATE('now'), 1)
           ON CONFLICT(date) DO UPDATE SET slots_found = slots_found + 1`
        ).run());
      } else if (unknownResult) {
        bgTasks.push(env.DB.prepare(
          `UPDATE jobs SET last_error_code = ? WHERE id = ?`
        ).bind(unknownResult.errorMessage || "UNKNOWN_RESPONSE", job.id).run());
      }

      if (!slotResult) return;

      const slotMonday = slotResult.matchedMonday;
      console.log(`Slot detected for Job ${job.id} on week ${slotMonday}. Acquiring DO lock...`);

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

      const decryptedClient: DecryptedClientData = {
        id: job.client_id,
        firstName: await decryptPII(job.first_name_enc, secret),
        lastName: await decryptPII(job.last_name_enc, secret),
        familyNameAtBirth: await decryptPII(job.family_name_at_birth_enc, secret),
        placeOfBirth: job.place_of_birth,
        countryOfBirth: job.country_of_birth,
        nationalityAtBirth: job.nationality_at_birth,
        street: await decryptPII(job.address_street_enc, secret),
        postalCode: await decryptPII(job.address_postal_code_enc, secret),
        city: await decryptPII(job.address_city_enc, secret),
        passportIssueDate: job.passport_issue_date,
        passportIssuingCountry: job.passport_issuing_country,
        gender: job.gender,
        dob: job.dob,
        nationality: job.nationality,
        passportNumber: await decryptPII(job.passport_number_enc, secret),
        passportExpiry: job.passport_expiry,
        email: await decryptPII(job.email_enc, secret),
        phone: await decryptPII(job.phone_enc, secret),
        category: job.category,
        calendarId: job.calendar_id
      };

      const isDryRun = env.DRY_RUN === "true";

      const httpRes = await executeDirectHttpBooking(decryptedClient, slotMonday, isDryRun);

      if (httpRes.isDryRun) {
        console.log(`[DRY-RUN] Halted prior to any submission for Job ${job.id} in ${httpRes.durationMs}ms.`);

        bgTasks.push(env.DB.prepare(
          `INSERT INTO audit_logs (job_id, client_id, event_type, duration_ms, details)
           VALUES (?, ?, 'DRY_RUN_STOPPED', ?, ?)`
        ).bind(job.id, job.client_id, httpRes.durationMs, JSON.stringify({ week: slotMonday })).run());

        await doStub.fetch("https://lock/release");

        if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
          bgTasks.push(sendTelegramNotification(
            env.TELEGRAM_BOT_TOKEN,
            env.TELEGRAM_CHAT_ID,
            `🔍 *[DRY-RUN] Appointment Slot Detected!*\n\nJob ID: \`${job.id}\`\nClient: \`${decryptedClient.firstName} ${decryptedClient.lastName}\`\nCalendar: \`${job.category}\`\nWeek: \`${slotMonday}\`\n\n*Status:* Dry-Run Safety active — booking path still UNVERIFIED (G0).`
          ));
        }
      } else if (httpRes.success) {
        console.log(`Booking completed for Job ${job.id}. Ref: ${httpRes.referenceId}`);
        // Guard: a cancel during the in-flight booking must win (D8 terminal semantics)
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
            `🎉 *[BOOKED] Appointment Secured!*\n\nClient: \`${decryptedClient.firstName} ${decryptedClient.lastName}\`\nPassport: \`${maskPassport(decryptedClient.passportNumber)}\`\nReference ID: \`${httpRes.referenceId}\`\nExecution Time: \`${httpRes.durationMs}ms\``
          ));
        }
      } else {
        console.warn(`[FALLBACK] Direct booking unavailable (${httpRes.errorMessage}). Launching Playwright...`);

        const pwRes = await executePlaywrightFallback(env.MYBROWSER, decryptedClient, isDryRun);

        bgTasks.push(env.DB.prepare(
          `INSERT INTO daily_metrics (date, total_browser_seconds) VALUES (DATE('now'), ?)
           ON CONFLICT(date) DO UPDATE SET total_browser_seconds = total_browser_seconds + ?`
        ).bind(pwRes.durationSeconds, pwRes.durationSeconds).run());

        await doStub.fetch("https://lock/release");

        if (!pwRes.success) {
          const checkCount = (job.check_count || 0) + 1;
          const backoffUntil = getBackoffUntilISO(checkCount);
          await env.DB.prepare(
            `UPDATE jobs SET status = 'BOOKING_FAILED', backoff_until = ?, last_error_code = ? WHERE id = ?`
          ).bind(backoffUntil, pwRes.errorMessage || "BOOKING_FAILED", job.id).run();

          bgTasks.push(env.DB.prepare(
            `INSERT INTO audit_logs (job_id, client_id, event_type, duration_ms, details)
             VALUES (?, ?, 'BOOKING_FAILED', ?, ?)`
          ).bind(job.id, job.client_id, Math.round(pwRes.durationSeconds * 1000), JSON.stringify({ error: pwRes.errorMessage })).run());
        }
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
  <title>نظام أوبيران لأتمتة الحجوزات — لوحة التحكم</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Alexandria:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    /* ===== Paper Dossier design system (hand-rolled, no framework CSS) =====
       v6: light editorial embassy case-file — parchment canvas, ink text, one
       burnt-red accent, ledger rules, zero shadows. Operator-directed per
       docs/ux-spec.md v6 (supersedes ClickHouse v5 near-black).
       ponytail: JetBrains Mono dropped — system mono stack + tabular-nums
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

    header {
      display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap;
      padding: 18px 22px; background: var(--bg-card); border: 1px solid var(--border);
      border-radius: var(--radius-card); margin-bottom: 22px;
    }

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
      .header { flex-direction: column; align-items: stretch; gap: 12px; }
      .btn { min-height: 44px; }
      .grid-metrics { grid-template-columns: repeat(2, 1fr); gap: 10px; }
      .metric-card { padding: 14px; }
      .metric-label { font-size: 10.5px; }
      .metric-val { font-size: 22px; }
      .form-grid { grid-template-columns: 1fr; }
      .row-actions { flex-wrap: wrap; }
    }
    @media (max-width: 480px) {
      .grid-metrics { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <button class="btn btn-primary" onclick="openModal()">+ إضافة مرشح جديد</button>
    </header>

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
    </div>

    <div class="table-card">
      <div class="table-header">
        <h2>قائمة مرشحي الحجز</h2>
        <span class="livetag" style="margin:0;"><span class="dot"></span><span class="txt">تحديث تلقائي 10 ثوانٍ</span></span>
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
    </div>

  </div>

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
            <option value="Master_PhD">ماجستير / دكتوراه / منح دراسية</option>
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
  </script>
</body>
</html>`;
}

