import { scanAvailability } from "./scanner";
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
      return new Response(getAdminHTML(env.DRY_RUN === "true"), {
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

    // Rolling 8-week horizon (AD-11): current week + 7 forward weeks, same for every job.
    // Requests stay ACTIVE until booked or cancelled — there is no date-based expiry (D8).
    const mondays = rollingMondays();

    for (const job of jobs) {

      let slotMonday: string | null = null;
      for (const mondayStr of mondays) {
        const result = await scanAvailability(job.calendar_id, mondayStr, env.SESSION_KV);

        await env.DB.prepare(
          `UPDATE jobs SET last_check = CURRENT_TIMESTAMP, check_count = check_count + 1 WHERE id = ?`
        )
          .bind(job.id)
          .run();

        await env.DB.prepare(
          `INSERT INTO daily_metrics (date, total_checks) VALUES (DATE('now'), 1)
           ON CONFLICT(date) DO UPDATE SET total_checks = total_checks + 1`
        ).run();

        const eventType = result.status === "SLOTS" ? "APPOINTMENT_FOUND" : result.status === "UNKNOWN" ? "UNKNOWN_RESPONSE" : "NO_APPOINTMENT";

        await env.DB.prepare(
          `INSERT INTO audit_logs (job_id, client_id, event_type, duration_ms, details)
           VALUES (?, ?, ?, ?, ?)`
        )
          .bind(
            job.id,
            job.client_id,
            eventType,
            result.durationMs,
            JSON.stringify({ week: mondayStr, responseLength: result.rawResponseLength, error: result.errorMessage })
          )
          .run();

        if (result.status === "SLOTS") {
          slotMonday = mondayStr;
          await env.DB.prepare(
            `INSERT INTO daily_metrics (date, slots_found) VALUES (DATE('now'), 1)
             ON CONFLICT(date) DO UPDATE SET slots_found = slots_found + 1`
          ).run();
          break;
        }
        if (result.status === "UNKNOWN") {
          await env.DB.prepare(
            `UPDATE jobs SET last_error_code = ? WHERE id = ?`
          )
            .bind(result.errorMessage || "UNKNOWN_RESPONSE", job.id)
            .run();
        }
      }

      if (!slotMonday) continue;

      console.log(`Slot detected for Job ${job.id} on week ${slotMonday}. Acquiring DO lock...`);

      const doId = env.JOB_LOCK.idFromName(job.id);
      const doStub = env.JOB_LOCK.get(doId);
      const lockRes = await doStub.fetch("https://lock/acquire");

      if (!lockRes.ok) {
        console.warn(`DO Lock rejected for Job ${job.id}: Lock already held.`);
        continue;
      }

      const secret = requireSecret(env);
      if (!secret) {
        console.error("PII_ENCRYPTION_KEY not configured; releasing lock and aborting.");
        await doStub.fetch("https://lock/release");
        continue;
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

        await env.DB.prepare(
          `INSERT INTO audit_logs (job_id, client_id, event_type, duration_ms, details)
           VALUES (?, ?, 'DRY_RUN_STOPPED', ?, ?)`
        )
          .bind(
            job.id,
            job.client_id,
            httpRes.durationMs,
            JSON.stringify({ week: slotMonday })
          )
          .run();

        await doStub.fetch("https://lock/release");

        if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
          await sendTelegramNotification(
            env.TELEGRAM_BOT_TOKEN,
            env.TELEGRAM_CHAT_ID,
            `🔍 *[DRY-RUN] Appointment Slot Detected!*\n\nJob ID: \`${job.id}\`\nClient: \`${decryptedClient.firstName} ${decryptedClient.lastName}\`\nCalendar: \`${job.category}\`\nWeek: \`${slotMonday}\`\n\n*Status:* Dry-Run Safety active — booking path still UNVERIFIED (G0).`
          );
        }
      } else if (httpRes.success) {
        console.log(`Booking completed for Job ${job.id}. Ref: ${httpRes.referenceId}`);
        // Guard: a cancel during the in-flight booking must win (D8 terminal semantics)
        await env.DB.prepare(
          `UPDATE jobs SET status = 'BOOKED' WHERE id = ? AND status = 'ACTIVE' AND enabled = 1`
        ).bind(job.id).run();
        await doStub.fetch("https://lock/seal");
        await env.DB.prepare(
          `INSERT INTO daily_metrics (date, bookings_completed) VALUES (DATE('now'), 1)
           ON CONFLICT(date) DO UPDATE SET bookings_completed = bookings_completed + 1`
        ).run();

        if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
          await sendTelegramNotification(
            env.TELEGRAM_BOT_TOKEN,
            env.TELEGRAM_CHAT_ID,
            `🎉 *[BOOKED] Appointment Secured!*\n\nClient: \`${decryptedClient.firstName} ${decryptedClient.lastName}\`\nPassport: \`${maskPassport(decryptedClient.passportNumber)}\`\nReference ID: \`${httpRes.referenceId}\`\nExecution Time: \`${httpRes.durationMs}ms\``
          );
        }
      } else {
        console.warn(`[FALLBACK] Direct booking unavailable (${httpRes.errorMessage}). Launching Playwright...`);

        const pwRes = await executePlaywrightFallback(env.MYBROWSER, decryptedClient, isDryRun);

        await env.DB.prepare(
          `INSERT INTO daily_metrics (date, total_browser_seconds) VALUES (DATE('now'), ?)
           ON CONFLICT(date) DO UPDATE SET total_browser_seconds = total_browser_seconds + ?`
        )
          .bind(pwRes.durationSeconds, pwRes.durationSeconds)
          .run();

        await doStub.fetch("https://lock/release");

        if (!pwRes.success) {
          const checkCount = (job.check_count || 0) + 1;
          const backoffUntil = getBackoffUntilISO(checkCount);
          await env.DB.prepare(
            `UPDATE jobs SET status = 'BOOKING_FAILED', backoff_until = ?, last_error_code = ? WHERE id = ?`
          )
            .bind(backoffUntil, pwRes.errorMessage || "BOOKING_FAILED", job.id)
            .run();

          await env.DB.prepare(
            `INSERT INTO audit_logs (job_id, client_id, event_type, duration_ms, details)
             VALUES (?, ?, 'BOOKING_FAILED', ?, ?)`
          )
            .bind(job.id, job.client_id, Math.round(pwRes.durationSeconds * 1000), JSON.stringify({ error: pwRes.errorMessage }))
            .run();
        }
      }
    }
  }
};

function getAdminHTML(isDryRun: boolean): string {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>نظام أوبيران لأتمتة الحجوزات — لوحة التحكم</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-surface: #0a0d14;
      --bg-card: #121722;
      --bg-card-hover: #171e2c;
      --border: rgba(255, 255, 255, 0.07);
      --border-accent: rgba(59, 130, 246, 0.3);
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --success: #10b981;
      --success-bg: rgba(16, 185, 129, 0.12);
      --warning: #f59e0b;
      --warning-bg: rgba(245, 158, 11, 0.12);
      --danger: #ef4444;
      --danger-bg: rgba(239, 68, 68, 0.12);
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --text-dim: #6b7280;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg-surface);
      color: var(--text);
      font-family: 'Cairo', system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      padding: 24px;
      line-height: 1.5;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 24px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      margin-bottom: 24px;
    }
    .brand-group { display: flex; align-items: center; gap: 16px; }
    .brand-title { font-size: 20px; font-weight: 800; color: #fff; letter-spacing: -0.3px; }
    .badge-fastpath {
      background: rgba(16, 185, 129, 0.15);
      color: var(--success);
      border: 1px solid rgba(16, 185, 129, 0.25);
      padding: 4px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 700;
    }
    .badge-dryrun {
      background: var(--warning-bg);
      color: var(--warning);
      border: 1px solid rgba(245, 158, 11, 0.25);
      padding: 4px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 700;
    }
    .btn {
      background: var(--primary);
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 8px;
      font-weight: 700;
      cursor: pointer;
      font-size: 14px;
      font-family: inherit;
      transition: all 0.15s ease;
    }
    .btn:hover { background: var(--primary-hover); transform: translateY(-1px); }
    .btn-sm { padding: 6px 14px; font-size: 13px; }
    .btn-secondary { background: rgba(255,255,255,0.06); color: var(--text); border: 1px solid var(--border); }
    .btn-secondary:hover { background: rgba(255,255,255,0.12); }
    .grid-metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .metric-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
    }
    .metric-label { font-size: 13px; color: var(--text-muted); font-weight: 600; margin-bottom: 8px; }
    .metric-val { font-size: 28px; font-weight: 800; color: #fff; }
    .table-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 24px;
    }
    .table-header {
      padding: 16px 24px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .table-header h2 { font-size: 16px; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; text-align: right; }
    th, td { padding: 16px 24px; border-bottom: 1px solid var(--border); font-size: 14px; }
    th { color: var(--text-muted); font-weight: 600; background: rgba(0,0,0,0.15); }
    .mono { font-family: 'JetBrains Mono', monospace; direction: ltr; display: inline-block; }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 700;
    }
    .status-active { background: var(--success-bg); color: var(--success); }
    .status-paused { background: var(--warning-bg); color: var(--warning); }
    .modal-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.75);
      backdrop-filter: blur(6px);
      z-index: 100;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .modal {
      background: #151b26;
      border: 1px solid var(--border);
      border-radius: 16px;
      width: 100%;
      max-width: 520px;
      padding: 28px;
    }
    .table-wrapper {
      width: 100%;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    .modal-title { font-size: 18px; font-weight: 800; margin-bottom: 20px; }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-size: 13px; font-weight: 600; color: var(--text-muted); margin-bottom: 6px; }
    .form-group input, .form-group select {
      width: 100%;
      padding: 10px 14px;
      background: #0d1117;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: #fff;
      font-size: 14px;
      font-family: inherit;
      min-height: 44px;
    }
    .form-group input:focus, .form-group select:focus {
      outline: none;
      border-color: var(--primary);
    }
    @media (max-width: 768px) {
      body { padding: 12px; }
      .header {
        flex-direction: column;
        align-items: stretch;
        gap: 14px;
        padding: 16px;
      }
      .brand-group {
        flex-wrap: wrap;
        gap: 8px;
      }
      .brand-title { font-size: 18px; }
      .btn { width: 100%; text-align: center; min-height: 44px; }
      .grid-metrics {
        grid-template-columns: repeat(2, 1fr);
        gap: 10px;
      }
      .metric-card { padding: 14px; }
      .metric-label { font-size: 12px; }
      .metric-val { font-size: 22px; }
      table { min-width: 580px; }
      th, td { padding: 12px 14px; font-size: 13px; }
      .form-grid { grid-template-columns: 1fr; gap: 10px; }
      .modal { padding: 20px; max-height: 92vh; overflow-y: auto; }
    }
    @media (max-width: 480px) {
      .grid-metrics { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <div class="brand-group">
        <div class="brand-title">أوبيران لأتمتة الحجوزات</div>
        <div class="badge-fastpath">⚡ محرك الفحص السريع</div>
        ${isDryRun ? '<div class="badge-dryrun">🛡️ وضع الاختبار التجريبي DRY-RUN</div>' : ''}
      </div>
      <button class="btn" onclick="openModal()">+ إضافة مرشح جديد</button>
    </header>

    <div class="grid-metrics">
      <div class="metric-card">
        <div class="metric-label">المرشحون النشطون</div>
        <div class="metric-val" id="val-active">-- / 10</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">نافذة الفحص: 07:00 – 18:00 بتوقيت القاهرة</div>
        <div class="metric-val" id="val-cairo" style="font-size: 18px;">جاري الفحص...</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">فحوصات اليوم</div>
        <div class="metric-val" id="val-checks">0</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">الحجوزات الناجحة</div>
        <div class="metric-val" style="color: var(--success);" id="val-booked">0</div>
      </div>
    </div>

    <div class="table-card">
      <div class="table-header">
        <h2>قائمة مرشحي الحجز</h2>
      </div>
      <div class="table-wrapper">
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
            <tr>
              <td colspan="5" style="text-align: center; color: var(--text-muted);">جاري تحميل بيانات المرشحين...</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- Modal -->
  <div class="modal-backdrop" id="client-modal">
    <div class="modal">
      <div class="modal-title">إضافة مرشح جديد للنظام</div>
      <form id="add-client-form">
        <div class="form-grid">
          <div class="form-group">
            <label>الاسم الأول</label>
            <input type="text" id="firstName" required placeholder="أحمد">
          </div>
          <div class="form-group">
            <label>اسم العائلة</label>
            <input type="text" id="lastName" required placeholder="حسن">
          </div>
        </div>
        <div class="form-group">
          <label>فئة الحجز</label>
          <select id="category">
            <option value="Bachelor">بكالوريوس / تعليم جامعي</option>
            <option value="Master_PhD">ماجستير / دكتوراه / منح دراسية</option>
          </select>
        </div>
        <div class="form-group" style="background: rgba(59,130,246,0.08); border: 1px solid var(--border-accent); border-radius: 8px; padding: 12px 14px; font-size: 13px; color: var(--text-muted);">
          ⏰ قواعد المواعيد موحّدة لجميع الطلبات: الفحص يوميًا من 07:00 حتى 18:00 بتوقيت القاهرة، والطلب يبقى نشطًا حتى إتمام الحجز أو الإلغاء.
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>اسم العائلة عند الميلاد</label>
            <input type="text" id="familyNameAtBirth" required>
          </div>
          <div class="form-group">
            <label>مكان الميلاد</label>
            <input type="text" id="placeOfBirth" required placeholder="القاهرة">
          </div>
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>بلد الميلاد</label>
            <input type="text" id="countryOfBirth" required placeholder="مصر">
          </div>
          <div class="form-group">
            <label>الجنسية عند الميلاد</label>
            <input type="text" id="nationalityAtBirth" required placeholder="مصري">
          </div>
        </div>
        <div class="form-group">
          <label>الشارع / العنوان</label>
          <input type="text" id="street" required placeholder="١٢ شارع التحرير">
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>الرمز البريدي</label>
            <input type="text" id="postalCode" required placeholder="11511" style="direction: ltr;">
          </div>
          <div class="form-group">
            <label>المدينة</label>
            <input type="text" id="city" required placeholder="القاهرة">
          </div>
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>رقم جواز السفر</label>
            <input type="text" id="passportNumber" required placeholder="A12345678" style="direction: ltr;">
          </div>
          <div class="form-group">
            <label>تاريخ انتهاء الجواز</label>
            <input type="date" id="passportExpiry" required>
          </div>
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>تاريخ إصدار الجواز</label>
            <input type="date" id="passportIssueDate" required>
          </div>
          <div class="form-group">
            <label>جهة إصدار الجواز</label>
            <input type="text" id="passportIssuingCountry" required placeholder="مصر">
          </div>
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>تاريخ الميلاد</label>
            <input type="date" id="dob" required>
          </div>
          <div class="form-group">
            <label>النوع</label>
            <select id="gender">
              <option value="Male">ذكر</option>
              <option value="Female">أنثى</option>
            </select>
          </div>
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label>البريد الإلكتروني</label>
            <input type="email" id="email" required placeholder="client@example.com" style="direction: ltr;">
          </div>
          <div class="form-group">
            <label>رقم الهاتف</label>
            <input type="tel" id="phone" required placeholder="+201000000000" style="direction: ltr;">
          </div>
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 12px; margin-top: 24px;">
          <button type="button" class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
          <button type="submit" class="btn">حفظ وإنشاء المهمة</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    function openModal() { document.getElementById('client-modal').style.display = 'flex'; }
    function closeModal() { document.getElementById('client-modal').style.display = 'none'; }

    async function toggleJob(jobId, action) {
      await fetch('/api/jobs/' + jobId + '/' + action, { method: 'POST' });
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
      const res = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        alert('فشل الحفظ: ' + (err && err.error ? err.error : res.status));
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
        const tbody = document.getElementById('client-rows');
        
        if (clients.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">لا يوجد مرشحون حالياً. انقر على "+ إضافة مرشح جديد" لإنشاء طلب.</td></tr>';
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
            <td>
              \${c.jobId && c.status !== 'CANCELLED' && c.status !== 'BOOKED' ? \`
                <button class="btn btn-sm btn-secondary" onclick="toggleJob('\${c.jobId}', '\${c.jobEnabled ? 'pause' : 'activate'}')">
                  \${c.jobEnabled ? 'إيقاف مؤقت' : 'تفعيل'}
                </button>
                <button class="btn btn-sm btn-secondary" onclick="toggleJob('\${c.jobId}', 'cancel')" style="color: var(--danger);">إلغاء</button>
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
