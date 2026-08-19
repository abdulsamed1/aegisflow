/**
 * BMEIA Single-POST Availability Scanner
 * Conforms to Architectural Invariants AD-4 & G0 Portal Specification
 */

export interface ScanResult {
  hasSlots: boolean;
  rawResponseLength: number;
  durationMs: number;
  errorMessage?: string;
  matchedMonday: string;
}

export async function scanAvailability(
  calendarId: number,
  mondayDateString: string // Format: M/d/yyyy 12:00:00 AM
): Promise<ScanResult> {
  const startTime = Date.now();
  const url = "https://appointment.bmeia.gv.at/HomeWeb/Scheduler";

  const params = new URLSearchParams();
  params.append("Language", "en");
  params.append("Office", "KAIRO");
  params.append("CalendarId", calendarId.toString());
  params.append("PersonCount", "1");
  params.append("Monday", mondayDateString);
  params.append("Command", "Next");

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Cookie": "AspxAutoDetectCookieSupport=1"
      },
      body: params.toString()
    });

    const durationMs = Date.now() - startTime;

    if (!response.ok) {
      return {
        hasSlots: false,
        rawResponseLength: 0,
        durationMs,
        errorMessage: `HTTP ${response.status} ${response.statusText}`,
        matchedMonday: mondayDateString
      };
    }

    const html = await response.text();

    // Detection Contract from G0 Portal Spec:
    // 1. Presence of 'message-error' indicates NO appointments available.
    // 2. Absence of 'message-error' indicates potential open slot!
    const hasErrorMsg = html.includes("message-error") || html.includes("no appointments available");
    const hasSlots = !hasErrorMsg;

    return {
      hasSlots,
      rawResponseLength: html.length,
      durationMs,
      matchedMonday: mondayDateString
    };
  } catch (error: any) {
    return {
      hasSlots: false,
      rawResponseLength: 0,
      durationMs: Date.now() - startTime,
      errorMessage: error.message || "Network request failed",
      matchedMonday: mondayDateString
    };
  }
}
