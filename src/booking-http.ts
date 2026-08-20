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
