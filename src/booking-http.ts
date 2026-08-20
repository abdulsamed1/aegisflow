/**
 * Booking Engine — G0-gated
 * The portal booking path (slot selection, form fields, submit endpoint) is UNVERIFIED.
 * Until the first live slot is captured (portal-automation-spec section 8), live booking
 * is disabled and Dry-Run payload preparation is the only allowed operation.
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
  isDryRun: boolean;
  referenceId?: string;
  requiresPlaywrightFallback: boolean;
  errorMessage?: string;
  responseLength?: number;
}

/**
 * Pre-serialize the VERIFIED discovery payload only.
 * Booking form fields and submit endpoint are UNVERIFIED (G0) and must not be invented.
 */
export function buildPreSerializedPayload(client: DecryptedClientData, mondayDateString: string): string {
  const params = new URLSearchParams();
  params.append("Language", "en");
  params.append("Office", "KAIRO");
  params.append("CalendarId", client.calendarId.toString());
  params.append("PersonCount", "1");
  params.append("Monday", mondayDateString);
  params.append("Command", "Next");
  return params.toString();
}

/**
 * Dry-Run: prepares the verified payload and halts before any submission.
 * Live mode: disabled until the booking path is verified at first slot capture (G0).
 * Never fabricates a booking reference.
 */
export async function executeDirectHttpBooking(
  client: DecryptedClientData,
  mondayDateString: string,
  isDryRun: boolean = true
): Promise<HttpBookingResult> {
  const startTime = Date.now();

  const body = client.preSerializedBody || buildPreSerializedPayload(client, mondayDateString);

  if (isDryRun) {
    const durationMs = Date.now() - startTime;
    console.log(`[DRY-RUN] Verified discovery payload for client ${client.id} ready in ${durationMs}ms. Halted prior to any submission.`);
    return {
      clientId: client.id,
      success: true,
      durationMs,
      isDryRun: true,
      requiresPlaywrightFallback: false,
      responseLength: 0
    };
  }

  return {
    clientId: client.id,
    success: false,
    durationMs: Date.now() - startTime,
    isDryRun: false,
    requiresPlaywrightFallback: true,
    errorMessage: "Booking path UNVERIFIED (portal-automation-spec section 6): live booking disabled until first slot capture"
  };
}

/**
 * Batch dispatcher — Dry-Run only until G0 closes.
 */
export async function executeBatchFastPathBookings(
  clients: DecryptedClientData[],
  mondayDateString: string,
  isDryRun: boolean = true
): Promise<HttpBookingResult[]> {
  if (!isDryRun) {
    return clients.map((c) => ({
      clientId: c.id,
      success: false,
      durationMs: 0,
      isDryRun: false,
      requiresPlaywrightFallback: true,
      errorMessage: "Live batch booking disabled until G0 closes (portal-automation-spec section 8)"
    }));
  }

  const preppedClients = clients.map((c) => ({
    ...c,
    preSerializedBody: buildPreSerializedPayload(c, mondayDateString)
  }));

  return Promise.all(
    preppedClients.map((client) => executeDirectHttpBooking(client, mondayDateString, isDryRun))
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
 * Form fields match live portal screenshots (18 PII fields, split postal code & city, MM/DD/YYYY dates, GDPR consent, CAPTCHA).
 */
export function buildStep3DetailsPayload(
  client: DecryptedClientData,
  captchaText: string,
  appointmentDate?: string,
  timeSlot?: string
): string {
  const params = new URLSearchParams();
  params.append("Language", "en");
  params.append("Office", "KAIRO");
  params.append("CalendarId", client.calendarId.toString());
  params.append("PersonCount", "1");

  if (appointmentDate) params.append("AppointmentDate", appointmentDate);
  if (timeSlot) params.append("TimeSlot", timeSlot);

  params.append("LastName", client.lastName);
  params.append("FirstName", client.firstName);
  params.append("DOB", formatDateForPortal(client.dob));
  params.append("PassportNumber", client.passportNumber);
  params.append("Gender", client.gender);
  params.append("Street", client.street);
  params.append("PostalCode", client.postalCode);
  params.append("City", client.city);
  params.append("Country", client.countryOfBirth || "EGYPT");
  params.append("Phone", client.phone);
  params.append("Email", client.email);
  params.append("FamilyNameAtBirth", client.familyNameAtBirth);
  params.append("NationalityAtBirth", client.nationalityAtBirth);
  params.append("CountryOfBirth", client.countryOfBirth);
  params.append("PlaceOfBirth", client.placeOfBirth);
  params.append("CurrentNationality", client.nationality);
  params.append("PassportIssueDate", formatDateForPortal(client.passportIssueDate));
  params.append("PassportExpiry", formatDateForPortal(client.passportExpiry));
  params.append("PassportIssuingCountry", client.passportIssuingCountry);
  params.append("Consent", "true");
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
