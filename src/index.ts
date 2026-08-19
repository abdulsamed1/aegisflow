import { scanAvailability } from "./scanner";
import { getCairoTimeInfo, calculateMondayString } from "./scheduler";
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
        const secret = env.PII_ENCRYPTION_KEY || "default-secret";
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
              gender: c.gender,
              dob: c.dob,
              nationality: c.nationality,
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
        const body: any = await request.json();
        const secret = env.PII_ENCRYPTION_KEY || "default-secret";
        const clientId = `client_${Date.now()}`;

        const firstNameEnc = await encryptPII(body.firstName, secret);
        const lastNameEnc = await encryptPII(body.lastName, secret);
        const passportEnc = await encryptPII(body.passportNumber, secret);
        const emailEnc = await encryptPII(body.email, secret);
        const phoneEnc = await encryptPII(body.phone, secret);

        const calendarId = body.category === "Master_PhD" ? 44279679 : 44281520;

        await env.DB.prepare(
          `INSERT INTO clients (id, first_name_enc, last_name_enc, gender, dob, nationality, passport_number_enc, passport_expiry, email_enc, phone_enc, category, calendar_id, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'READY')`
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
            body.category,
            calendarId
          )
          .run();

        // Auto-create matching Job record
        const jobId = `job_${Date.now()}`;
        await env.DB.prepare(
          `INSERT INTO jobs (id, client_id, enabled, status, start_date, end_date, allowed_days)
           VALUES (?, ?, 1, 'ACTIVE', ?, ?, ?)`
        )
          .bind(
            jobId,
            clientId,
            body.startDate || "2026-09-01",
            body.endDate || "2026-10-31",
            JSON.stringify(body.allowedDays || ["Monday", "Tuesday", "Wednesday", "Thursday"])
          )
          .run();

        return new Response(JSON.stringify({ success: true, clientId, jobId }), {
          status: 201,
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

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const cairo = getCairoTimeInfo();
    if (!cairo.isWithinWindow) {
      console.log(`Outside operating window (${cairo.formattedCairoTime}). Skipping scan.`);
      return;
    }

    // Circuit Breaker Check (NFR-2)
    const metricsToday = await env.DB.prepare(
      "SELECT * FROM daily_metrics WHERE date = DATE('now')"
    ).first<any>() || { total_browser_seconds: 0.0, budget_alert_sent: 0 };

    if (isCircuitBreakerTripped(metricsToday.total_browser_seconds || 0.0)) {
      console.warn(`🚨 Circuit breaker tripped (Daily browser budget ${metricsToday.total_browser_seconds}s >= 540s). Execution halted.`);
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

    // Query next active job by oldest last_check timestamp (Fair Scheduler AD-7)
    const job = await env.DB.prepare(
      `SELECT jobs.*, clients.*
       FROM jobs 
       JOIN clients ON jobs.client_id = clients.id
       WHERE jobs.enabled = 1 
         AND jobs.status = 'ACTIVE' 
         AND (jobs.backoff_until IS NULL OR jobs.backoff_until <= CURRENT_TIMESTAMP)
       ORDER BY jobs.last_check ASC 
       LIMIT 1`
    ).first<any>();

    if (!job) {
      console.log("No eligible active jobs found for scan cycle.");
      return;
    }

    const mondayStr = calculateMondayString();
    console.log(`Scanning availability for Job ${job.id} (Calendar: ${job.calendar_id}) on week ${mondayStr}...`);

    const result = await scanAvailability(job.calendar_id, mondayStr);

    // Update job check timestamp & increment total_checks metric
    await env.DB.prepare(
      `UPDATE jobs SET last_check = CURRENT_TIMESTAMP, check_count = check_count + 1 WHERE id = ?`
    )
      .bind(job.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO daily_metrics (date, total_checks) VALUES (DATE('now'), 1)
       ON CONFLICT(date) DO UPDATE SET total_checks = total_checks + 1`
    ).run();

    // Log check event
    await env.DB.prepare(
      `INSERT INTO audit_logs (job_id, client_id, event_type, duration_ms, details)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(
        job.id,
        job.client_id,
        result.hasSlots ? "SLOT_MATCHED" : "NO_APPOINTMENT",
        result.durationMs,
        JSON.stringify({ responseLength: result.rawResponseLength, error: result.errorMessage })
      )
      .run();

    if (result.hasSlots) {
      console.log(`🔥 SLOT DETECTED for Job ${job.id}! Triggering Direct HTTP Fast-Path Booking Engine...`);

      // Acquire Durable Object Lock (AD-5)
      const doId = env.JOB_LOCK.idFromName(job.id);
      const doStub = env.JOB_LOCK.get(doId);
      const lockRes = await doStub.fetch("https://lock/acquire");

      if (!lockRes.ok) {
        console.warn(`DO Lock rejected for Job ${job.id}: Lock already held.`);
        return;
      }

      // Decrypt PII fields for HTTP Fast-Path execution
      const secret = env.PII_ENCRYPTION_KEY || "default-secret";
      const decryptedClient: DecryptedClientData = {
        id: job.client_id,
        firstName: await decryptPII(job.first_name_enc, secret),
        lastName: await decryptPII(job.last_name_enc, secret),
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

      // Primary Path: Direct HTTP Fast-Path Engine (~10ms–50ms)
      const httpRes = await executeDirectHttpBooking(decryptedClient, mondayStr, isDryRun);

      if (httpRes.isDryRun) {
        console.log(`⚡ [FAST-PATH DRY-RUN] Halted prior to POST for Job ${job.id} in ${httpRes.durationMs}ms.`);

        await env.DB.prepare(
          `INSERT INTO audit_logs (job_id, client_id, event_type, duration_ms, details)
           VALUES (?, ?, 'DRY_RUN_STOPPED', ?, ?)`
        )
          .bind(
            job.id,
            job.client_id,
            httpRes.durationMs,
            JSON.stringify({ engine: "Direct-HTTP-FastPath", latencyMs: httpRes.durationMs })
          )
          .run();

        if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
          await sendTelegramNotification(
            env.TELEGRAM_BOT_TOKEN,
            env.TELEGRAM_CHAT_ID,
            `⚡ *[FAST-PATH ~10ms DRY-RUN] Appointment Slot Detected!*\n\nJob ID: \`${job.id}\`\nClient: \`${decryptedClient.firstName} ${decryptedClient.lastName}\`\nCalendar: \`${job.category}\`\nWeek: \`${mondayStr}\`\nFast-Path Latency: \`${httpRes.durationMs}ms\`\n\n*Status:* Fast-Path Direct HTTP payload prepared in <15ms. Dry-Run Safety active.`
          );
        }
      } else if (httpRes.success) {
        console.log(`🎉 [FAST-PATH SUCCESS] Booking completed in ${httpRes.durationMs}ms! Ref: ${httpRes.referenceId}`);
        await env.DB.prepare(`UPDATE jobs SET status = 'BOOKED' WHERE id = ?`).bind(job.id).run();
        await env.DB.prepare(
          `INSERT INTO daily_metrics (date, bookings_completed, slots_found) VALUES (DATE('now'), 1, 1)
           ON CONFLICT(date) DO UPDATE SET bookings_completed = bookings_completed + 1, slots_found = slots_found + 1`
        ).run();

        if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
          await sendTelegramNotification(
            env.TELEGRAM_BOT_TOKEN,
            env.TELEGRAM_CHAT_ID,
            `🎉 *[FAST-PATH BOOKED] Appointment Secured!* 🎉\n\nClient: \`${decryptedClient.firstName} ${decryptedClient.lastName}\`\nPassport: \`${maskPassport(decryptedClient.passportNumber)}\`\nReference ID: \`${httpRes.referenceId}\`\nExecution Time: \`${httpRes.durationMs}ms\` (Direct HTTP Fast-Path)`
          );
        }
      } else if (httpRes.requiresPlaywrightFallback) {
        console.warn(`[FAST-PATH FALLBACK] Direct HTTP failed (${httpRes.errorMessage}). Launching Playwright browser fallback...`);

        const pwRes = await executePlaywrightFallback(env.MYBROWSER, decryptedClient, isDryRun);

        // Record browser seconds in daily metrics
        await env.DB.prepare(
          `INSERT INTO daily_metrics (date, total_browser_seconds) VALUES (DATE('now'), ?)
           ON CONFLICT(date) DO UPDATE SET total_browser_seconds = total_browser_seconds + ?`
        )
          .bind(pwRes.durationSeconds, pwRes.durationSeconds)
          .run();

        if (!pwRes.success) {
          const checkCount = (job.check_count || 0) + 1;
          const backoffUntil = getBackoffUntilISO(checkCount);
          await env.DB.prepare(
            `UPDATE jobs SET status = 'BOOKING_FAILED', backoff_until = ? WHERE id = ?`
          )
            .bind(backoffUntil, job.id)
            .run();
        }
      }
    }
  }
};

function getAdminHTML(isDryRun: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OPRAN BOOKING — Admin Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-dark: #0b0f19;
      --bg-card: rgba(22, 30, 46, 0.7);
      --border-glass: rgba(255, 255, 255, 0.08);
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg-dark);
      color: var(--text);
      font-family: 'Inter', sans-serif;
      min-height: 100vh;
      padding: 24px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 24px;
      background: var(--bg-card);
      backdrop-filter: blur(12px);
      border: 1px solid var(--border-glass);
      border-radius: 12px;
      margin-bottom: 24px;
    }
    .title-group { display: flex; align-items: center; gap: 16px; }
    .brand { font-size: 20px; font-weight: 700; letter-spacing: -0.5px; }
    .badge-fastpath {
      background: rgba(16, 185, 129, 0.15);
      color: var(--success);
      border: 1px solid rgba(16, 185, 129, 0.3);
      padding: 4px 12px;
      border-radius: 99px;
      font-size: 12px;
      font-weight: 600;
    }
    .badge-dryrun {
      background: rgba(245, 158, 11, 0.15);
      color: var(--warning);
      border: 1px solid rgba(245, 158, 11, 0.3);
      padding: 4px 12px;
      border-radius: 99px;
      font-size: 12px;
      font-weight: 600;
    }
    .btn {
      background: var(--primary);
      color: white;
      border: none;
      padding: 10px 18px;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
      font-size: 13px;
      transition: background 0.2s;
    }
    .btn:hover { background: var(--primary-hover); }
    .btn-sm { padding: 4px 10px; font-size: 12px; }
    .btn-danger { background: rgba(239, 68, 68, 0.2); color: var(--danger); border: 1px solid rgba(239, 68, 68, 0.3); }
    .btn-danger:hover { background: var(--danger); color: white; }
    .grid-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border-glass);
      border-radius: 12px;
      padding: 20px;
    }
    .card-title { font-size: 12px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px; font-weight: 600; }
    .card-val { font-size: 26px; font-weight: 700; }
    .table-container {
      background: var(--bg-card);
      border: 1px solid var(--border-glass);
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 24px;
    }
    table { width: 100%; border-collapse: collapse; text-align: left; }
    th, td { padding: 16px 20px; border-bottom: 1px solid var(--border-glass); }
    th { font-size: 12px; color: var(--text-muted); text-transform: uppercase; }
    .pill {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 99px;
      font-size: 12px;
      font-weight: 600;
    }
    .pill-active { background: rgba(16, 185, 129, 0.15); color: var(--success); }
    .pill-paused { background: rgba(245, 158, 11, 0.15); color: var(--warning); }
    /* Modal Styles */
    .modal-overlay {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.7);
      backdrop-filter: blur(8px);
      z-index: 100;
      align-items: center;
      justify-content: center;
    }
    .modal {
      background: #111827;
      border: 1px solid var(--border-glass);
      border-radius: 16px;
      width: 100%;
      max-width: 500px;
      padding: 28px;
    }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-size: 13px; color: var(--text-muted); margin-bottom: 6px; }
    .form-group input, .form-group select {
      width: 100%;
      padding: 10px;
      background: #1f2937;
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      color: white;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title-group">
      <div class="brand">OPRAN BOOKING</div>
      <div class="badge-fastpath">⚡ FAST-PATH HTTP ~10ms</div>
      ${isDryRun ? '<div class="badge-dryrun">🛡️ DRY-RUN SAFETY ACTIVE</div>' : ''}
    </div>
    <div>
      <button class="btn" onclick="openModal()">+ Add Client Candidate</button>
    </div>
  </div>

  <div class="grid-stats">
    <div class="card">
      <div class="card-title">Active Client Jobs</div>
      <div class="card-val" id="val-active">-- / 10</div>
    </div>
    <div class="card">
      <div class="card-title">Operating Window</div>
      <div class="card-val" id="val-cairo" style="font-size: 18px;">Checking...</div>
    </div>
    <div class="card">
      <div class="card-title">Checks Executed Today</div>
      <div class="card-val" id="val-checks">0</div>
    </div>
    <div class="card">
      <div class="card-title">Successful Bookings</div>
      <div class="card-val" style="color: var(--success);" id="val-booked">0</div>
    </div>
  </div>

  <div class="table-container">
    <table>
      <thead>
        <tr>
          <th>Candidate Name</th>
          <th>Category</th>
          <th>Masked Passport</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="client-rows">
        <tr>
          <td colspan="5" style="text-align: center; color: var(--text-muted);">Loading candidates...</td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- Add Client Modal -->
  <div class="modal-overlay" id="client-modal">
    <div class="modal">
      <h2 style="margin-bottom: 20px; font-size: 18px;">Add New Client Candidate</h2>
      <form id="add-client-form">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div class="form-group">
            <label>First Name</label>
            <input type="text" id="firstName" required placeholder="Ahmed">
          </div>
          <div class="form-group">
            <label>Last Name</label>
            <input type="text" id="lastName" required placeholder="Hassan">
          </div>
        </div>
        <div class="form-group">
          <label>Category</label>
          <select id="category">
            <option value="Bachelor">Bachelor (Bachelor Candidate)</option>
            <option value="Master_PhD">Master / PhD / Scholarship</option>
          </select>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div class="form-group">
            <label>Passport Number</label>
            <input type="text" id="passportNumber" required placeholder="A12345678">
          </div>
          <div class="form-group">
            <label>Passport Expiry</label>
            <input type="date" id="passportExpiry" required>
          </div>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div class="form-group">
            <label>Date of Birth</label>
            <input type="date" id="dob" required>
          </div>
          <div class="form-group">
            <label>Gender</label>
            <select id="gender">
              <option value="Male">Male</option>
              <option value="Female">Female</option>
            </select>
          </div>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div class="form-group">
            <label>Email</label>
            <input type="email" id="email" required placeholder="client@domain.com">
          </div>
          <div class="form-group">
            <label>Phone</label>
            <input type="tel" id="phone" required placeholder="+201000000000">
          </div>
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 12px; margin-top: 20px;">
          <button type="button" class="btn btn-danger" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn">Save & Create Job</button>
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
        category: document.getElementById('category').value,
        passportNumber: document.getElementById('passportNumber').value,
        passportExpiry: document.getElementById('passportExpiry').value,
        dob: document.getElementById('dob').value,
        gender: document.getElementById('gender').value,
        email: document.getElementById('email').value,
        phone: document.getElementById('phone').value,
        nationality: 'Egyptian'
      };
      await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      closeModal();
      loadDashboard();
    };

    async function loadDashboard() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        document.getElementById('val-active').innerText = data.activeJobs + ' / 10';
        document.getElementById('val-cairo').innerText = data.cairoTime.formattedCairoTime + (data.cairoTime.isWithinWindow ? ' (Open)' : ' (Closed)');
        document.getElementById('val-checks').innerText = data.metricsToday.total_checks || 0;
        document.getElementById('val-booked').innerText = data.metricsToday.bookings_completed || 0;

        const clientsRes = await fetch('/api/clients');
        const clients = await clientsRes.json();
        const tbody = document.getElementById('client-rows');
        
        if (clients.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No candidate clients added yet. Click "+ Add Client Candidate" above.</td></tr>';
          return;
        }

        tbody.innerHTML = clients.map(c => \`
          <tr>
            <td style="font-weight: 600;">\${c.firstName} \${c.lastName}</td>
            <td>\${c.category}</td>
            <td style="font-family: 'JetBrains Mono', monospace;">\${c.maskedPassport}</td>
            <td><span class="pill \${c.jobEnabled ? 'pill-active' : 'pill-paused'}">\${c.status}</span></td>
            <td>
              \${c.jobId ? \`
                <button class="btn btn-sm" onclick="toggleJob('\${c.jobId}', '\${c.jobEnabled ? 'pause' : 'activate'}')">
                  \${c.jobEnabled ? 'Pause' : 'Activate'}
                </button>
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
