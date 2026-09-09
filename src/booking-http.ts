/**
 * Booking Engine — live booking only (DRY_RUN removed per operator request).
 * NOTE: executeDirectHttpBooking/executeBatchFastPathBookings are DEAD for live booking;
 * scheduled() uses Playwright wizard only (FR-7). Retained for payload helper tests.
 *  keep helpers (formatDateForPortal, buildStep3DetailsPayload, parseBookingConfirmationReference) — scanner/wizard need them.
 */

export interface DecryptedClientData {
  id: string;
  firstName: string;
  lastName: string;
  familyNameAtBirth: string;
  placeOfBirth: string;
  countryOfBirth: string;
  nationalityAtBirth: string;
  street: string;
  postalCode: string;
  city: string;
  passportIssueDate: string;
  passportIssuingCountry: string;
  gender: string;
  dob: string;
  nationality: string;
  passportNumber: string;
  passportExpiry: string;
  email: string;
  phone: string;
  category: string;
  calendarId: number;
  preSerializedBody?: string;
}

export interface HttpBookingResult {
  clientId: string;
  success: boolean;
  durationMs: number;
  referenceId?: string;
  requiresPlaywrightFallback: boolean;
  errorMessage?: string;
  responseLength?: number;
}

import { CANONICAL_CALENDAR_ID } from "./pre-submit-gate";

/**
 * Pre-serialize the VERIFIED discovery payload only.
 * Booking form fields and submit endpoint are UNVERIFIED (G0) and must not be invented.
 */
export function buildPreSerializedPayload(client: DecryptedClientData, mondayDateString: string): string {
  if (client.category !== "Bachelor" || client.calendarId !== CANONICAL_CALENDAR_ID) {
    throw new Error(`Bachelor category and canonical calendar ID (${CANONICAL_CALENDAR_ID}) required. Got category="${client.category}", calendarId=${client.calendarId}`);
  }
  const params = new URLSearchParams();
  params.append("Language", "en");
  params.append("Office", "KAIRO");
  params.append("CalendarId", client.calendarId.toString());
  params.append("PersonCount", "1");
  params.append("Monday", mondayDateString);
  params.append("Command", "Next");
  return params.toString();
}

export async function executeDirectHttpBooking(
  client: DecryptedClientData,
  mondayDateString: string,
  cookie?: string
): Promise<HttpBookingResult> {
  const startTime = Date.now();

  const body = client.preSerializedBody || buildStep3DetailsPayload(client, "AUTO", mondayDateString);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Origin": "https://appointment.bmeia.gv.at",
      "Referer": "https://appointment.bmeia.gv.at/HomeWeb/Scheduler"
    };

    if (cookie) {
      headers["Cookie"] = cookie;
    }

    const response = await fetch("https://appointment.bmeia.gv.at/HomeWeb/Scheduler", {
      method: "POST",
      headers,
      body
    });

    const html = await response.text();
    const durationMs = Date.now() - startTime;
    const ref = parseBookingConfirmationReference(html);

    if (ref) {
      return {
        clientId: client.id,
        success: true,
        durationMs,
        referenceId: ref,
        requiresPlaywrightFallback: false,
        responseLength: html.length
      };
    }

    return {
      clientId: client.id,
      success: false,
      durationMs,
      requiresPlaywrightFallback: true,
      errorMessage: "HTTP response received but booking confirmation reference missing (falling back to browser)",
      responseLength: html.length
    };
  } catch (err: any) {
    return {
      clientId: client.id,
      success: false,
      durationMs: Date.now() - startTime,
      requiresPlaywrightFallback: true,
      errorMessage: err?.message || "Direct HTTP submission network error"
    };
  }
}

/**
 * Batch dispatcher — live booking.
 */
export async function executeBatchFastPathBookings(
  clients: DecryptedClientData[],
  mondayDateString: string,
  cookie?: string
): Promise<HttpBookingResult[]> {
  const preppedClients = clients.map((c) => ({
    ...c,
    preSerializedBody: buildStep3DetailsPayload(c, "AUTO", mondayDateString)
  }));

  return Promise.all(
    preppedClients.map((client) => executeDirectHttpBooking(client, mondayDateString, cookie))
  );
}

/**
 * Converts ISO YYYY-MM-DD date strings (or standard date strings) to portal format MM/DD/YYYY.
 * Example: "1997-03-21" -> "03/21/1997"
 */
export function formatDateForPortal(isoDate: string): string {
  if (!isoDate || typeof isoDate !== "string") return "";
  const trimmed = isoDate.trim();

  // Already in MM/DD/YYYY format
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(trimmed)) {
    return trimmed;
  }

  // YYYY-MM-DD or YYYY/MM/DD
  const parts = trimmed.split(/[-/]/);
  if (parts.length === 3 && parts[0].length === 4) {
    const [year, month, day] = parts;
    const m = month.padStart(2, "0");
    const d = day.padStart(2, "0");
    return `${m}/${d}/${year}`;
  }

  return trimmed;
}

/**
 * Pre-serialize Step 3 personal details & CAPTCHA payload matching live portal specification.
 * Field names verified via London E2E (scratchpad_hkcax71f.md): 31 fields incl. BDC_* hidden.
 *  keep fabricated AppointmentDate/TimeSlot for backward compat but prefer StartTime + hidden Token/BDC
 */
export function buildStep3DetailsPayload(
  client: DecryptedClientData,
  captchaText: string,
  appointmentDate?: string,
  timeSlot?: string,
  hidden?: { token?: string; startTime?: string; bdc?: { vcid: string; hs: string; sp: string; bw: string } }
): string {
  if (client.category !== "Bachelor" || client.calendarId !== CANONICAL_CALENDAR_ID) {
    throw new Error(`Bachelor category and canonical calendar ID (${CANONICAL_CALENDAR_ID}) required. Got category="${client.category}", calendarId=${client.calendarId}`);
  }
  const params = new URLSearchParams();
  params.append("Language", "en");
  params.append("Office", "KAIRO");
  params.append("CalendarId", client.calendarId.toString());
  params.append("PersonCount", "1");

  if (hidden?.token) params.append("Token", hidden.token);
  // Prefer explicit StartTime from hidden, fallback to legacy appointmentDate
  const startTime = hidden?.startTime || appointmentDate;
  if (startTime) params.append("StartTime", startTime);
  if (timeSlot) params.append("TimeSlot", timeSlot);

  params.append("Lastname", client.lastName);
  params.append("Firstname", client.firstName);
  params.append("DateOfBirth", formatDateForPortal(client.dob));
  params.append("TraveldocumentNumber", client.passportNumber);
  params.append("Sex", client.gender);
  params.append("Street", client.street);
  params.append("Postcode", client.postalCode);
  params.append("City", client.city);
  params.append("Country", client.countryOfBirth || "EGYPT");
  params.append("Telephone", client.phone);
  params.append("Email", client.email);
  params.append("LastnameAtBirth", client.familyNameAtBirth);
  params.append("NationalityAtBirth", client.nationalityAtBirth);
  params.append("CountryOfBirth", client.countryOfBirth);
  params.append("PlaceOfBirth", client.placeOfBirth);
  params.append("NationalityForApplication", client.nationality);
  params.append("TraveldocumentDateOfIssue", formatDateForPortal(client.passportIssueDate));
  params.append("TraveldocumentValidUntil", formatDateForPortal(client.passportExpiry));
  params.append("TraveldocumentIssuingAuthority", client.passportIssuingCountry);
  params.append("DSGVOAccepted", "true");
  if (hidden?.bdc) {
    params.append("BDC_VCID_Captcha", hidden.bdc.vcid);
    params.append("BDC_BackWorkaround_Captcha", hidden.bdc.bw);
    params.append("BDC_Hs_Captcha", hidden.bdc.hs);
    params.append("BDC_SP_Captcha", hidden.bdc.sp);
  }
  params.append("CaptchaText", captchaText);
  params.append("Command", "Save");

  return params.toString();
}

/**
 * Parses the booking reference ID (e.g. "GESX-KAIRO" or "GESX-123456") from final confirmation HTML (Terminreservierung).
 */
export function parseBookingConfirmationReference(html: string): string | null {
  if (!html || typeof html !== "string") return null;

  // Match GESX-<OFFICE/CODE> pattern
  const match = html.match(/GESX-[A-Z0-9_-]+/i);
  if (match) {
    return match[0].toUpperCase();
  }

  // Match alternative reference ID label pattern e.g. "رقم الحجز: GESX-KAIRO"
  const labelMatch = html.match(/(?:رقم الحجز|Booking Reference|Reference ID)[:\s]+([A-Z0-9_-]+)/i);
  if (labelMatch) {
    return labelMatch[1].toUpperCase();
  }

  return null;
}
