/**
 * BMEIA Single-POST Availability Scanner
 * Conforms to G0 Portal Specification: docs/portal-automation-spec.md (section 5)
 */

export type ScanStatus = "NO_SLOTS" | "SLOTS" | "UNKNOWN";

export interface ScanResult {
  status: ScanStatus;
  hasSlots: boolean;
  rawResponseLength: number;
  durationMs: number;
  errorMessage?: string;
  matchedMonday: string;
}

const PORTAL_BASE = "https://appointment.bmeia.gv.at";

export async function getSessionCookie(kv?: KVNamespace): Promise<string> {
  if (kv) {
    const cached = await kv.get("bmeia_session_cookie");
    if (cached) return cached;
  }

  const warm = await fetch(PORTAL_BASE + "/", { method: "GET", redirect: "manual" });
  const setCookie = warm.headers.get("set-cookie") || "";
  const aspx = setCookie.match(/AspxAutoDetectCookieSupport=[^;,]+/i)?.[0] || "AspxAutoDetectCookieSupport=1";
  const sessionId = setCookie.match(/ASP\.NET_SessionId=[^;,]+/i)?.[0];
  const cookie = sessionId ? `${aspx}; ${sessionId}` : aspx;

  if (kv && cookie) {
    await kv.put("bmeia_session_cookie", cookie, { expirationTtl: 1800 });
  }
  return cookie;
}

export async function scanAvailability(
  calendarId: number,
  mondayDateString: string, // Format: M/d/yyyy 12:00:00 AM
  cookie: string
): Promise<ScanResult> {
  const startTime = Date.now();

  const params = new URLSearchParams();
  params.append("Language", "en");
  params.append("Office", "KAIRO");
  params.append("CalendarId", calendarId.toString());
  params.append("PersonCount", "1");
  params.append("Monday", mondayDateString);
  params.append("Command", "Next");

  try {
    const response = await fetch(PORTAL_BASE + "/HomeWeb/Scheduler", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Cookie": cookie
      },
      body: params.toString()
    });

    const durationMs = Date.now() - startTime;

    if (!response.ok) {
      return {
        status: "UNKNOWN",
        hasSlots: false,
        rawResponseLength: 0,
        durationMs,
        errorMessage: `HTTP ${response.status}`,
        matchedMonday: mondayDateString
      };
    }

    const html = await response.text();

    // G0 detection contract (3-state):
    // 1. message-error / "no appointments available" -> NO_SLOTS
    // 2. Scheduler page without error and non-empty week grid -> SLOTS
    // 3. anything else -> UNKNOWN (never triggers a booking)
    const noSlots = html.includes("no appointments available") || html.includes("message-error");
    if (noSlots) {
      return { status: "NO_SLOTS", hasSlots: false, rawResponseLength: html.length, durationMs, matchedMonday: mondayDateString };
    }

    const form = html.match(/<form action="\/HomeWeb\/Scheduler"[\s\S]*?<\/form>/);
    if (form) {
      const tables = form[0].match(/<table class="no-border">[\s\S]*?<\/table>/g) || [];
      const grid = tables[tables.length - 1] || "";
      const gridText = grid.replace(/<[^>]+>/g, "").trim();
      if (gridText) {
        return { status: "SLOTS", hasSlots: true, rawResponseLength: html.length, durationMs, matchedMonday: mondayDateString };
      }
    }

    return {
      status: "UNKNOWN",
      hasSlots: false,
      rawResponseLength: html.length,
      durationMs,
      errorMessage: "Unexpected response structure",
      matchedMonday: mondayDateString
    };
  } catch (error: any) {
    return {
      status: "UNKNOWN",
      hasSlots: false,
      rawResponseLength: 0,
      durationMs: Date.now() - startTime,
      errorMessage: error.message || "Network request failed",
      matchedMonday: mondayDateString
    };
  }
}
